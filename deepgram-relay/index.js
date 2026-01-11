/**
 * Deepgram WebSocket Relay Server
 * 
 * HIPAA-safe relay for real-time medical transcription.
 * 
 * Deployment: ECS Fargate + ALB (NOT App Runner - WebSocket issues)
 * 
 * Single port serves both:
 * - GET /health → HTTP 200 health check
 * - WebSocket /dictate → Deepgram streaming relay
 * 
 * Protocol:
 * 1. Client connects to wss://<RELAY_DOMAIN>/dictate
 * 2. Client sends: { "type": "auth", "access_token": "<supabase_jwt>" }
 * 3. Client streams binary PCM16 frames (16kHz, mono)
 * 4. Relay forwards to Deepgram and returns transcripts
 * 5. Client sends: { "type": "stop" } to finalize
 * 
 * PHI-Safe Logging: No transcript text or audio content is logged.
 */

const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// Configuration from environment
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

// Validate required environment variables
if (!DEEPGRAM_API_KEY) {
  console.error('[FATAL] DEEPGRAM_API_KEY is required');
  process.exit(1);
}
if (!SUPABASE_JWT_SECRET) {
  console.error('[FATAL] SUPABASE_JWT_SECRET is required for local JWT verification');
  process.exit(1);
}

// Active sessions tracking
const sessions = new Map();

/**
 * Verify Supabase JWT locally using HS256 signature
 * No network call - fast and robust for WebSocket auth
 */
function verifyToken(accessToken) {
  try {
    // Verify HS256 signature using Supabase JWT secret
    const decoded = jwt.verify(accessToken, SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    
    // Extract user ID from 'sub' claim (standard JWT)
    const userId = decoded.sub;
    if (!userId) {
      console.error('[Auth] JWT missing sub claim');
      return null;
    }
    
    // Check expiration (jwt.verify already does this, but be explicit)
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      console.error('[Auth] JWT expired');
      return null;
    }
    
    return { userId };
  } catch (err) {
    // Log error type without sensitive details
    if (err.name === 'TokenExpiredError') {
      console.error('[Auth] JWT expired');
    } else if (err.name === 'JsonWebTokenError') {
      console.error('[Auth] JWT invalid signature or format');
    } else {
      console.error('[Auth] JWT verification failed');
    }
    return null;
  }
}

/**
 * Build Deepgram WebSocket URL with query parameters
 */
function buildDeepgramUrl() {
  const params = new URLSearchParams({
    model: DEEPGRAM_CONFIG.model,
    language: DEEPGRAM_CONFIG.language,
    encoding: DEEPGRAM_CONFIG.encoding,
    sample_rate: String(DEEPGRAM_CONFIG.sample_rate),
    channels: String(DEEPGRAM_CONFIG.channels),
    interim_results: String(DEEPGRAM_CONFIG.interim_results),
    endpointing: String(DEEPGRAM_CONFIG.endpointing),
    punctuate: String(DEEPGRAM_CONFIG.punctuate),
    smart_format: String(DEEPGRAM_CONFIG.smart_format),
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

/**
 * Create HTTP server for health checks and WebSocket upgrades
 */
const server = http.createServer((req, res) => {
  // Health check endpoint for ALB
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      sessions: sessions.size,
      uptime: process.uptime()
    }));
    return;
  }
  
  // Root endpoint
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'deepgram-relay', status: 'running' }));
    return;
  }
  
  // 404 for other HTTP requests
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

/**
 * Create WebSocket server attached to HTTP server
 */
const wss = new WebSocket.Server({ 
  server, 
  path: '/dictate'
});

console.log(`[Relay] Starting server on port ${PORT}`);

/**
 * Handle WebSocket connections
 */
wss.on('connection', (clientWs, req) => {
  const sessionId = Math.random().toString(36).substring(7);
  const origin = req.headers.origin || '';
  const connectTime = Date.now();
  
  console.log(`[${sessionId}] Client connected, origin: ${origin}`);
  
  // Origin check (if ALLOWED_ORIGINS is configured)
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`[${sessionId}] Origin not allowed`);
    clientWs.close(4003, 'Origin not allowed');
    return;
  }
  
  // Session state
  const session = {
    id: sessionId,
    authenticated: false,
    userId: null,
    deepgramWs: null,
    audioBytesSent: 0,
    partialCount: 0,
    finalCount: 0,
    finalTranscriptLength: 0,
    startTime: null,
    connectionTimeout: null,
    keepAliveInterval: null,
    flushTimeout: null,
    isStopping: false,
    doneSent: false,
  };
  
  sessions.set(sessionId, session);
  
  // Connection timeout (5 seconds to authenticate)
  session.connectionTimeout = setTimeout(() => {
    if (!session.authenticated) {
      console.warn(`[${sessionId}] Auth timeout - closing`);
      clientWs.close(4001, 'Authentication timeout');
    }
  }, 5000);
  
  /**
   * Start KeepAlive interval to Deepgram
   */
  function startKeepAlive() {
    if (session.keepAliveInterval) {
      clearInterval(session.keepAliveInterval);
    }
    
    session.keepAliveInterval = setInterval(() => {
      if (session.deepgramWs?.readyState === WebSocket.OPEN && !session.isStopping) {
        try {
          session.deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
        } catch (err) {
          console.error(`[${sessionId}] KeepAlive send failed`);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }
  
  /**
   * Stop KeepAlive interval
   */
  function stopKeepAlive() {
    if (session.keepAliveInterval) {
      clearInterval(session.keepAliveInterval);
      session.keepAliveInterval = null;
    }
  }
  
  /**
   * Connect to Deepgram once authenticated
   */
  function connectToDeepgram() {
    const dgUrl = buildDeepgramUrl();
    console.log(`[${sessionId}] Connecting to Deepgram...`);
    
    const dgWs = new WebSocket(dgUrl, {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
      },
    });
    
    session.deepgramWs = dgWs;
    session.startTime = Date.now();
    
    dgWs.on('open', () => {
      console.log(`[${sessionId}] Deepgram connected`);
      clientWs.send(JSON.stringify({ type: 'ready' }));
      
      // Start KeepAlive to prevent Deepgram idle timeout
      startKeepAlive();
    });
    
    dgWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'Results') {
          const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
          const isFinal = msg.is_final || false;
          
          if (isFinal) {
            session.finalCount++;
            session.finalTranscriptLength += transcript.length;
            
            // Send final transcript to client
            clientWs.send(JSON.stringify({
              type: 'final',
              text: transcript,
              speech_final: msg.speech_final || false,
            }));
          } else if (transcript) {
            session.partialCount++;
            
            // Send partial transcript to client
            clientWs.send(JSON.stringify({
              type: 'partial',
              text: transcript,
            }));
          }
        } else if (msg.type === 'Metadata') {
          console.log(`[${sessionId}] Deepgram metadata received`);
        } else if (msg.type === 'UtteranceEnd') {
          clientWs.send(JSON.stringify({ type: 'utterance_end' }));
        }
      } catch (err) {
        // Ignore parse errors for non-JSON messages
      }
    });
    
    dgWs.on('close', (code, reason) => {
      console.log(`[${sessionId}] Deepgram closed: ${code}`);
      stopKeepAlive();
      session.deepgramWs = null;
      
      // Clear flush timeout since Deepgram closed on its own
      if (session.flushTimeout) {
        clearTimeout(session.flushTimeout);
        session.flushTimeout = null;
      }
      
      // If we were stopping, send done message (if not already sent)
      if (session.isStopping && !session.doneSent) {
        session.doneSent = true;
        const duration = Date.now() - (session.startTime || Date.now());
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'done',
            stats: {
              durationMs: duration,
              audioBytesSent: session.audioBytesSent,
              partialCount: session.partialCount,
              finalCount: session.finalCount,
              finalTranscriptLength: session.finalTranscriptLength,
            },
          }));
        }
      }
    });
    
    dgWs.on('error', (err) => {
      console.error(`[${sessionId}] Deepgram error`);
      stopKeepAlive();
      session.deepgramWs = null;
      
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', error: 'Deepgram connection failed' }));
      }
    });
  }
  
  /**
   * Handle client messages
   */
  clientWs.on('message', (data, isBinary) => {
    // Binary data = audio
    if (isBinary) {
      if (!session.authenticated) {
        console.warn(`[${sessionId}] Audio received before auth`);
        return;
      }
      
      if (session.deepgramWs?.readyState === WebSocket.OPEN && !session.isStopping) {
        session.deepgramWs.send(data);
        session.audioBytesSent += data.length;
      }
      return;
    }
    
    // Text data = JSON commands
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'auth') {
        if (session.authenticated) {
          console.warn(`[${sessionId}] Already authenticated`);
          return;
        }
        
        // Local JWT verification (no network call)
        const authResult = verifyToken(msg.access_token);
        
        if (!authResult) {
          console.warn(`[${sessionId}] Auth failed`);
          clientWs.send(JSON.stringify({ type: 'error', error: 'Authentication failed' }));
          clientWs.close(4002, 'Authentication failed');
          return;
        }
        
        session.authenticated = true;
        session.userId = authResult.userId;
        clearTimeout(session.connectionTimeout);
        
        console.log(`[${sessionId}] Authenticated`);
        clientWs.send(JSON.stringify({ type: 'authenticated' }));
        
        // Connect to Deepgram
        connectToDeepgram();
        
      } else if (msg.type === 'stop') {
        console.log(`[${sessionId}] Stop received`);
        session.isStopping = true;
        
        // Stop KeepAlive
        stopKeepAlive();
        
        // Helper to send done message (only once)
        const sendDone = () => {
          if (session.doneSent) return;
          session.doneSent = true;
          
          // Clear flush timeout if still pending
          if (session.flushTimeout) {
            clearTimeout(session.flushTimeout);
            session.flushTimeout = null;
          }
          
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'done',
              stats: {
                durationMs: Date.now() - (session.startTime || Date.now()),
                audioBytesSent: session.audioBytesSent,
                partialCount: session.partialCount,
                finalCount: session.finalCount,
                finalTranscriptLength: session.finalTranscriptLength,
              },
            }));
          }
        };
        
        // Send CloseStream to Deepgram to flush final results
        if (session.deepgramWs?.readyState === WebSocket.OPEN) {
          try {
            session.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
            console.log(`[${sessionId}] CloseStream sent, waiting for flush...`);
          } catch (err) {
            console.error(`[${sessionId}] CloseStream send failed`);
          }
          
          // Start flush timer (2500ms) - if Deepgram hasn't closed by then, force close
          session.flushTimeout = setTimeout(() => {
            console.log(`[${sessionId}] Flush timeout expired, closing Deepgram`);
            session.flushTimeout = null;
            
            if (session.deepgramWs) {
              session.deepgramWs.close();
              session.deepgramWs = null;
            }
            
            sendDone();
          }, 2500);
          
          // Also handle Deepgram closing on its own (the 'close' handler will call sendDone)
          // The dgWs.on('close') handler already exists and will trigger when Deepgram closes
          
        } else {
          // No Deepgram connection, send done immediately
          sendDone();
        }
        
      } else if (msg.type === 'ping') {
        clientWs.send(JSON.stringify({ type: 'pong' }));
      }
      
    } catch (err) {
      console.error(`[${sessionId}] Invalid message format`);
    }
  });
  
  /**
   * Handle client disconnect
   */
  clientWs.on('close', () => {
    const duration = Date.now() - connectTime;
    console.log(`[${sessionId}] Client disconnected after ${duration}ms, bytes: ${session.audioBytesSent}, finals: ${session.finalCount}`);
    
    // Cleanup
    clearTimeout(session.connectionTimeout);
    stopKeepAlive();
    
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
      session.flushTimeout = null;
    }
    
    if (session.deepgramWs) {
      session.deepgramWs.close();
    }
    sessions.delete(sessionId);
  });
  
  clientWs.on('error', (err) => {
    console.error(`[${sessionId}] Client WebSocket error`);
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`[Relay] Server listening on port ${PORT}`);
  console.log(`[Relay] Health check: http://localhost:${PORT}/health`);
  console.log(`[Relay] WebSocket: ws://localhost:${PORT}/dictate`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Relay] SIGTERM received, closing connections...');
  
  // Close all sessions
  sessions.forEach((session) => {
    if (session.keepAliveInterval) {
      clearInterval(session.keepAliveInterval);
    }
    if (session.flushTimeout) {
      clearTimeout(session.flushTimeout);
    }
    if (session.deepgramWs) {
      session.deepgramWs.close();
    }
  });
  
  wss.close();
  server.close(() => {
    console.log('[Relay] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Relay] SIGINT received');
  process.emit('SIGTERM');
});

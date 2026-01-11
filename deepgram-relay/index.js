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
const { createClient } = require('@supabase/supabase-js');

// Configuration from environment
const PORT = process.env.PORT || 8080;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);

// Deepgram configuration for medical transcription
const DEEPGRAM_CONFIG = {
  model: 'nova-2-medical',
  language: 'en-US',
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  endpointing: 300,
  punctuate: true,
  smart_format: true,
};

// KeepAlive interval (Deepgram requires activity every 10s, we send every 3s to be safe)
const KEEPALIVE_INTERVAL_MS = 3000;

// Validate required environment variables
if (!DEEPGRAM_API_KEY) {
  console.error('[FATAL] DEEPGRAM_API_KEY is required');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_ANON_KEY are required');
  process.exit(1);
}

// Initialize Supabase client for JWT verification
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Active sessions tracking
const sessions = new Map();

/**
 * Verify Supabase JWT and return user info
 */
async function verifyToken(accessToken) {
  try {
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) {
      return null;
    }
    return { userId: user.id };
  } catch (err) {
    console.error('[Auth] Token verification failed');
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
    isStopping: false,
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
      
      // If we were stopping, send done message
      if (session.isStopping) {
        const duration = Date.now() - (session.startTime || Date.now());
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
  clientWs.on('message', async (data, isBinary) => {
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
        
        const authResult = await verifyToken(msg.access_token);
        
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
        
        // Send CloseStream to Deepgram to flush final results
        if (session.deepgramWs?.readyState === WebSocket.OPEN) {
          try {
            session.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
          } catch (err) {
            console.error(`[${sessionId}] CloseStream send failed`);
          }
          
          // Give Deepgram time to flush, then close
          setTimeout(() => {
            if (session.deepgramWs) {
              session.deepgramWs.close();
            }
          }, 1000);
        } else {
          // No Deepgram connection, send done immediately
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

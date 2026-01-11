# Deepgram WebSocket Relay

HIPAA-safe WebSocket relay for real-time medical transcription using Deepgram's `nova-2-medical` model.

## Why a Relay?

Supabase Edge Functions don't support WebSocket servers. This relay:
1. Authenticates clients using Supabase JWT
2. Connects to Deepgram server-side (keeps API key secure)
3. Forwards audio from client → Deepgram
4. Forwards transcripts from Deepgram → client
5. PHI-safe logging (no audio or transcript content logged)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | Yes | Deepgram API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key for JWT verification |
| `ALLOWED_ORIGINS` | No | Comma-separated allowed origins |
| `PORT` | No | WebSocket port (default: 8080) |
| `HEALTH_PORT` | No | Health check port (default: 8081) |

## Deployment Options

### Option 1: AWS App Runner (Recommended)

```bash
# Build and push Docker image
docker build -t deepgram-relay .
docker tag deepgram-relay:latest <account>.dkr.ecr.<region>.amazonaws.com/deepgram-relay:latest
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker push <account>.dkr.ecr.<region>.amazonaws.com/deepgram-relay:latest

# Create App Runner service via console or CLI
```

### Option 2: ECS/Fargate

Use the Dockerfile with your ECS task definition.

### Option 3: Local Development

```bash
npm install
DEEPGRAM_API_KEY=xxx SUPABASE_URL=xxx SUPABASE_ANON_KEY=xxx npm start
```

## Client Protocol

1. Connect: `wss://<RELAY_DOMAIN>/dictate`
2. Authenticate: `{ "type": "auth", "access_token": "<supabase_jwt>" }`
3. Wait for: `{ "type": "ready" }`
4. Stream: Binary PCM16 audio frames (16kHz, mono)
5. Receive: `{ "type": "partial", "text": "..." }` or `{ "type": "final", "text": "..." }`
6. Stop: `{ "type": "stop" }`
7. Receive: `{ "type": "done", "stats": {...} }`

## Deepgram Configuration

- Model: `nova-2-medical`
- Sample Rate: 16kHz
- Encoding: PCM16 (linear16)
- Channels: 1 (mono)
- Interim Results: enabled
- Endpointing: 300ms
- Smart Format: enabled

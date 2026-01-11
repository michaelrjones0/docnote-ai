# Deepgram Streaming Integration

## Architecture Overview

This implements a "fast + accurate" first-pass pipeline:

```
Browser → ALB (wss://) → ECS Fargate → Deepgram nova-2-medical → Final Transcript → OpenAI → Note
```

**User Experience:** Start → Stop → short "Generating…" → Note appears ONCE. No visible transcript switching or "refined" UI.

## Components

### 1. Deepgram WebSocket Relay (`deepgram-relay/`)
Node.js service for **ECS Fargate + ALB** deployment (NOT App Runner - WebSocket issues):

- `index.js` - WebSocket relay server with KeepAlive + CloseStream
- `Dockerfile` - Container configuration
- `ecs-task-definition.json` - ECS Fargate task definition
- `README.md` - Deployment instructions

**Key Features:**
- Single port (8080) for both `/health` and `/dictate` WebSocket
- KeepAlive frames every 3s to prevent Deepgram idle timeout
- CloseStream for proper finalization and final transcript flush
- Supabase JWT verification (no Deepgram key exposed to browser)

**Required Environment Variables:**
- `DEEPGRAM_API_KEY` - Deepgram API key
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - For JWT verification
- `ALLOWED_ORIGINS` - Comma-separated allowed origins

### 2. Client Hooks (`src/hooks/`)
- `useDeepgramStream.ts` - Real-time encounter transcription via relay
- `useDeepgramDictation.ts` - Field-level dictation
- `useDictationField.ts` - Register textareas for dictation

### 3. UI Components
- `EncounterTimings.tsx` - PHI-safe performance metrics display
- `GlobalDictationButton.tsx` - Toggle for field dictation
- `DictationContext.tsx` - Global dictation state management

## Configuration

Add to your `.env`:
```
VITE_DEEPGRAM_RELAY_URL=wss://relay.yourdomain.com/dictate
```

## Deployment Steps

1. **Build and push to ECR:**
   ```bash
   cd deepgram-relay
   docker build -t deepgram-relay .
   docker tag deepgram-relay:latest <ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/deepgram-relay:latest
   docker push <ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/deepgram-relay:latest
   ```

2. **Create secrets in AWS Secrets Manager** with DEEPGRAM_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

3. **Deploy ECS Fargate service** with ALB (see `deepgram-relay/README.md` for full steps)

4. **Configure ALB:**
   - HTTPS listener with SSL cert
   - Target group health check: `/health`
   - Idle timeout: 3600s (for WebSocket)
   - Stickiness: Enabled

5. **Set VITE_DEEPGRAM_RELAY_URL** in frontend

## Performance Targets

- Connection: <500ms
- Stop → Final Transcript: 0-2s (streaming, so immediate after CloseStream flush)
- Stop → Note Ready: <15s total for short encounters

## First-Pass UX Flow

1. User clicks **Start** → connect to relay → authenticate → start streaming audio
2. User clicks **Stop** → send `{ type: "stop" }` → relay sends CloseStream to Deepgram
3. Deepgram flushes final results → relay sends `{ type: "done" }` with stats
4. Client has complete transcript → call `generate-note` ONCE
5. Note appears ONCE → no "refined" version, no second pass

## PHI Safety

- No transcript content logged anywhere
- Only timing/byte counts in logs
- DEEPGRAM_API_KEY never exposed to browser
- Supabase JWT verified server-side

# Deepgram Streaming Integration

## Architecture Overview

This implements a "fast + accurate" first-pass pipeline:

```
Client → Deepgram Relay (AWS) → Deepgram nova-2-medical → Final Transcript → OpenAI → Note
```

**User Experience:** Start → Stop → short "Generating…" → Note appears ONCE. No visible transcript switching.

## Components Created

### 1. Deepgram WebSocket Relay (`deepgram-relay/`)
Node.js service for AWS App Runner deployment:
- `index.js` - WebSocket relay server
- `Dockerfile` - Container configuration
- `apprunner.yaml` - AWS App Runner config
- `README.md` - Deployment instructions

**Required Environment Variables for Relay:**
- `DEEPGRAM_API_KEY` - Deepgram API key
- `SUPABASE_URL` - For JWT verification
- `SUPABASE_ANON_KEY` - For JWT verification
- `ALLOWED_ORIGINS` - Comma-separated allowed origins

### 2. Client Hooks (`src/hooks/`)
- `useDeepgramStream.ts` - Real-time encounter transcription via relay
- `useDeepgramDictation.ts` - Field-level dictation (existing)
- `useDictationField.ts` - Register textareas for dictation

### 3. UI Components
- `EncounterTimings.tsx` - PHI-safe performance metrics display
- `GlobalDictationButton.tsx` - Toggle for field dictation
- `DictationContext.tsx` - Global dictation state management

## Configuration

Add to your `.env`:
```
VITE_DEEPGRAM_RELAY_URL=wss://your-relay-domain.awsapprunner.com/dictate
```

## Integration Steps

1. **Deploy Relay to AWS App Runner:**
   ```bash
   cd deepgram-relay
   docker build -t deepgram-relay .
   # Push to ECR and create App Runner service
   ```

2. **Set DEEPGRAM_API_KEY** in the relay environment

3. **Set VITE_DEEPGRAM_RELAY_URL** in the frontend

4. **Update AppHome.tsx** to use `useDeepgramStream` instead of current `useLiveScribe` when the relay URL is configured

## Performance Targets

- Connection: <500ms
- Stop → Final Transcript: 0-2s (streaming, so immediate)
- Stop → Note Ready: <15s total for short encounters

## PHI Safety

- No transcript content logged anywhere
- Only timing/byte counts in logs
- DEEPGRAM_API_KEY never exposed to browser

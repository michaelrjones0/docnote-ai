# Deepgram WebSocket Relay

HIPAA-safe WebSocket relay for real-time medical transcription using Deepgram's `nova-2-medical` model.

## Architecture

```
Browser → ALB (wss://) → ECS Fargate → Deepgram API
                ↓
         Supabase JWT verification
```

**Why NOT App Runner:** App Runner has unreliable WebSocket support for long-lived connections.

## Single Port Design

Port 8080 serves both:
- `GET /health` → HTTP 200 health check (for ALB)
- `WebSocket /dictate` → Deepgram streaming relay

## Key Features

- **KeepAlive**: Sends KeepAlive frames to Deepgram every 3s to prevent idle timeout
- **CloseStream**: Proper finalization to flush all pending transcripts
- **Supabase JWT Auth**: Verifies tokens server-side
- **PHI-Safe Logging**: No transcript or audio content logged

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | Yes | Deepgram API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key for JWT verification |
| `ALLOWED_ORIGINS` | No | Comma-separated allowed origins |
| `PORT` | No | Server port (default: 8080) |

## Deployment: ECS Fargate + ALB

### 1. Create ECR Repository

```bash
aws ecr create-repository --repository-name deepgram-relay
```

### 2. Build and Push Docker Image

```bash
cd deepgram-relay

# Build
docker build -t deepgram-relay .

# Tag
docker tag deepgram-relay:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/deepgram-relay:latest

# Login to ECR
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# Push
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/deepgram-relay:latest
```

### 3. Create Secrets in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name deepgram-relay/config \
  --secret-string '{
    "DEEPGRAM_API_KEY": "your-key",
    "SUPABASE_URL": "https://xxx.supabase.co",
    "SUPABASE_ANON_KEY": "your-anon-key",
    "ALLOWED_ORIGINS": "https://your-app.lovable.app"
  }'
```

### 4. Create ECS Cluster

```bash
aws ecs create-cluster --cluster-name deepgram-relay-cluster
```

### 5. Register Task Definition

Edit `ecs-task-definition.json` to replace placeholders, then:

```bash
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json
```

### 6. Create ALB with WebSocket Support

1. Create Application Load Balancer
2. Create Target Group with:
   - Protocol: HTTP
   - Port: 8080
   - Health check path: `/health`
   - Stickiness: Enabled (important for WebSocket)
3. Create HTTPS listener with SSL certificate
4. Configure idle timeout to 3600s (WebSocket connections)

### 7. Create ECS Service

```bash
aws ecs create-service \
  --cluster deepgram-relay-cluster \
  --service-name deepgram-relay \
  --task-definition deepgram-relay \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=deepgram-relay,containerPort=8080"
```

### 8. Configure DNS

Point your domain to the ALB (e.g., `relay.yourdomain.com`)

## Local Development

```bash
npm install

DEEPGRAM_API_KEY=xxx \
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_ANON_KEY=xxx \
npm start
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
- KeepAlive: every 3 seconds

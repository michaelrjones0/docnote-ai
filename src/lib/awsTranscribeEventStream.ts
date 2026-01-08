/**
 * AWS Transcribe Event Stream Protocol
 * 
 * Encodes/decodes audio frames and transcript events for AWS Transcribe Streaming.
 * Uses the AWS event stream binary format (prelude + headers + payload + message CRC).
 * 
 * Reference: https://docs.aws.amazon.com/transcribe/latest/dg/streaming-format.html
 */

// Simple CRC32 implementation for AWS event stream
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Encode an audio chunk as an AWS event stream message
 */
export function encodeAudioEvent(pcm16Data: Int16Array): Uint8Array {
  const payload = new Uint8Array(pcm16Data.buffer, pcm16Data.byteOffset, pcm16Data.byteLength);
  
  // Headers
  const contentTypeHeader = encodeHeader(':content-type', 'application/octet-stream');
  const eventTypeHeader = encodeHeader(':event-type', 'AudioEvent');
  const messageTypeHeader = encodeHeader(':message-type', 'event');
  
  const headers = concatUint8Arrays([contentTypeHeader, eventTypeHeader, messageTypeHeader]);
  
  // Prelude: total length (4) + headers length (4) + prelude CRC (4) = 12 bytes
  const totalLength = 12 + headers.length + payload.length + 4; // +4 for message CRC
  
  const prelude = new Uint8Array(8);
  const preludeView = new DataView(prelude.buffer);
  preludeView.setUint32(0, totalLength, false); // big-endian
  preludeView.setUint32(4, headers.length, false);
  
  const preludeCrc = crc32(prelude);
  const preludeCrcBytes = new Uint8Array(4);
  new DataView(preludeCrcBytes.buffer).setUint32(0, preludeCrc, false);
  
  // Full message without final CRC
  const messageWithoutCrc = concatUint8Arrays([prelude, preludeCrcBytes, headers, payload]);
  
  // Message CRC
  const messageCrc = crc32(messageWithoutCrc);
  const messageCrcBytes = new Uint8Array(4);
  new DataView(messageCrcBytes.buffer).setUint32(0, messageCrc, false);
  
  return concatUint8Arrays([messageWithoutCrc, messageCrcBytes]);
}

/**
 * Decode an AWS event stream message from binary data
 */
export function decodeEventMessage(data: Uint8Array): {
  headers: Record<string, string>;
  payload: Uint8Array;
} | null {
  if (data.length < 16) return null; // Minimum: 12 prelude + 4 message CRC
  
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  
  if (data.length < totalLength) return null; // Incomplete message
  
  // Skip prelude CRC verification for simplicity (AWS will send valid messages)
  const headersStart = 12;
  const headersEnd = headersStart + headersLength;
  const payloadStart = headersEnd;
  const payloadEnd = totalLength - 4; // Exclude message CRC
  
  const headers = decodeHeaders(data.slice(headersStart, headersEnd));
  const payload = data.slice(payloadStart, payloadEnd);
  
  return { headers, payload };
}

function encodeHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = new TextEncoder().encode(value);
  
  // Header format: name-length (1) + name + value-type (1) + value-length (2) + value
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  
  header[offset++] = nameBytes.length;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  
  header[offset++] = 7; // String type
  header[offset++] = (valueBytes.length >> 8) & 0xFF;
  header[offset++] = valueBytes.length & 0xFF;
  header.set(valueBytes, offset);
  
  return header;
}

function decodeHeaders(data: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {};
  let offset = 0;
  
  while (offset < data.length) {
    const nameLength = data[offset++];
    if (offset + nameLength > data.length) break;
    
    const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
    offset += nameLength;
    
    const valueType = data[offset++];
    
    if (valueType === 7) { // String type
      const valueLength = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      const value = new TextDecoder().decode(data.slice(offset, offset + valueLength));
      offset += valueLength;
      headers[name] = value;
    } else {
      // Skip unknown types - just break for now
      break;
    }
  }
  
  return headers;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Parse transcript result from AWS Transcribe response payload
 */
export interface TranscriptResult {
  isPartial: boolean;
  resultId: string;
  startTime: number;
  endTime: number;
  alternatives: Array<{
    transcript: string;
    items?: Array<{
      content: string;
      startTime: number;
      endTime: number;
      type: string;
      vocabularyFilterMatch?: boolean;
    }>;
  }>;
}

export function parseTranscriptEvent(payload: Uint8Array): TranscriptResult[] {
  try {
    const text = new TextDecoder().decode(payload);
    const data = JSON.parse(text);
    
    // AWS Transcribe Medical streaming response format
    const results = data.Transcript?.Results || [];
    
    return results.map((result: Record<string, unknown>) => ({
      isPartial: result.IsPartial ?? true,
      resultId: result.ResultId ?? '',
      startTime: result.StartTime ?? 0,
      endTime: result.EndTime ?? 0,
      alternatives: (Array.isArray(result.Alternatives) ? result.Alternatives : []).map((alt: Record<string, unknown>) => ({
        transcript: alt.Transcript ?? '',
        items: Array.isArray(alt.Items) ? alt.Items.map((item: Record<string, unknown>) => ({
          content: item.Content ?? '',
          startTime: item.StartTime ?? 0,
          endTime: item.EndTime ?? 0,
          type: item.Type ?? 'pronunciation',
          vocabularyFilterMatch: item.VocabularyFilterMatch ?? false,
        })) : undefined,
      })),
    }));
  } catch {
    return [];
  }
}

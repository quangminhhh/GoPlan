import { resolveRealtimeWebSocketUrl } from '../infrastructure/ws-url';

describe('resolveRealtimeWebSocketUrl', () => {
  it.each([
    ['http://localhost:8000', 'ws://localhost:8000/ws/realtime'],
    ['http://127.0.0.1:8000/', 'ws://127.0.0.1:8000/ws/realtime'],
    ['http://dev.localhost:8000/api', 'ws://dev.localhost:8000/ws/realtime'],
    ['https://api.example.com', 'wss://api.example.com/ws/realtime'],
    ['https://api.example.com/root?old=1#hash', 'wss://api.example.com/ws/realtime'],
  ])('derives the realtime endpoint from %s', (input, expected) => {
    expect(resolveRealtimeWebSocketUrl(input)).toBe(expected);
  });

  it.each([
    'http://api.example.com',
    'ftp://api.example.com',
    'not a url',
    'https://user:secret@api.example.com',
  ])('rejects unsafe or invalid server root %s', (input) => {
    expect(() => resolveRealtimeWebSocketUrl(input)).toThrow();
  });
});

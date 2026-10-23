import { flowServerUrl, relayTarget, serverUrlOf } from './relay';

const callbackUrl = 'https://chat.example.com/api/pull-requests/oauth/callback';

describe('serverUrlOf', () => {
  it.each([
    ['https://t1.example.com/', 'https://t1.example.com'],
    ['https://t1.example.com/chat/?x=1#y', 'https://t1.example.com/chat'],
    ['http://t1.localhost:3080', 'http://t1.localhost:3080'],
  ])('normalizes %s', (input, expected) => {
    expect(serverUrlOf(input)).toBe(expected);
  });

  it.each([undefined, '', 'not a url', 'javascript:alert(1)', 'https://user:pw@example.com'])(
    'refuses %p',
    (input) => {
      expect(serverUrlOf(input)).toBeUndefined();
    },
  );
});

describe('flowServerUrl', () => {
  it('names a tenant host the provider does not call back', () => {
    expect(flowServerUrl('https://t1.example.com', callbackUrl)).toBe('https://t1.example.com');
  });

  it('names nothing on the host the provider calls back, or without a server URL', () => {
    expect(flowServerUrl('https://chat.example.com/', callbackUrl)).toBeUndefined();
    expect(flowServerUrl(undefined, callbackUrl)).toBeUndefined();
  });
});

describe('relayTarget', () => {
  const originalUrl = '/api/pull-requests/oauth/callback?code=c&state=s';

  it("sends a callback on the deployment host on to the flow's own host, query and all", () => {
    expect(relayTarget('https://t1.example.com', 'https://chat.example.com', originalUrl)).toBe(
      'https://t1.example.com/api/pull-requests/oauth/callback?code=c&state=s',
    );
  });

  it('keeps a callback that is already on the flow host, or names no host', () => {
    expect(relayTarget('https://t1.example.com', 'https://t1.example.com/', originalUrl)).toBe(
      undefined,
    );
    expect(relayTarget(undefined, 'https://chat.example.com', originalUrl)).toBeUndefined();
  });
});

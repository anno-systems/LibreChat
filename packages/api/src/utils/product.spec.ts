import { getProductUrl, getProductName, getProductToken, getProductUserAgent } from './product';

describe('getProductName', () => {
  it("is upstream's name when APP_TITLE is unset or blank", () => {
    expect(getProductName({})).toBe('LibreChat');
    expect(getProductName({ APP_TITLE: '   ' })).toBe('LibreChat');
  });

  it('is APP_TITLE trimmed when set', () => {
    expect(getProductName({ APP_TITLE: '  OfficeChat ' })).toBe('OfficeChat');
    expect(getProductName({ APP_TITLE: 'Office Chat' })).toBe('Office Chat');
  });
});

describe('getProductToken', () => {
  it('removes spaces and other characters a header token cannot carry', () => {
    expect(getProductToken('Office Chat')).toBe('OfficeChat');
    expect(getProductToken('Office/Chat (Beta)')).toBe('OfficeChatBeta');
    expect(getProductToken('Office-Chat_2.0')).toBe('Office-Chat_2.0');
  });

  it("falls back to upstream's name when nothing is left", () => {
    expect(getProductToken('  ')).toBe('LibreChat');
  });

  it('builds integration User-Agents from the token', () => {
    expect(getProductUserAgent('Office Chat', 'Pull-Requests')).toBe('OfficeChat-Pull-Requests');
    expect(getProductUserAgent('LibreChat', 'Skill-Sync')).toBe('LibreChat-Skill-Sync');
  });
});

describe('getProductUrl', () => {
  it("is DOMAIN_CLIENT when set, else upstream's site", () => {
    expect(getProductUrl({})).toBe('https://librechat.ai');
    expect(getProductUrl({ DOMAIN_CLIENT: 'https://chat.example.com' })).toBe(
      'https://chat.example.com',
    );
  });
});

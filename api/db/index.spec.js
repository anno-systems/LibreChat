describe('api/db/index.js', () => {
  test('createModels is called before indexSync is loaded', () => {
    jest.resetModules();

    const callOrder = [];

    jest.mock('@librechat/data-schemas', () => ({
      createModels: jest.fn((m) => {
        callOrder.push('createModels');
        m.models.Message = { name: 'Message' };
        m.models.Conversation = { name: 'Conversation' };
      }),
    }));

    jest.mock('./indexSync', () => {
      callOrder.push('indexSync');
      return jest.fn();
    });

    jest.mock('./connect', () => ({ connectDb: jest.fn() }));

    require('./index');

    expect(callOrder).toEqual(['createModels', 'indexSync']);
  });

  test('indexSync runs in the system context, across tenants', async () => {
    jest.resetModules();
    const contexts = [];
    jest.mock('@librechat/data-schemas', () => ({
      createModels: jest.fn(),
      runAsSystem: jest.fn((fn) => {
        contexts.push('system');
        return fn();
      }),
    }));
    jest.mock('./indexSync', () =>
      jest.fn(async () => {
        contexts.push('sync');
      }),
    );
    jest.mock('./connect', () => ({ connectDb: jest.fn() }));

    await require('./index').indexSync();

    expect(contexts).toEqual(['system', 'sync']);
  });
});

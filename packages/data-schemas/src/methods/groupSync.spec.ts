import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createUserGroupMethods } from './userGroup';
import { createGroupSyncMethods } from './groupSync';
import groupSchema from '~/schema/group';
import userSchema from '~/schema/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Group: mongoose.Model<t.IGroup>;
let User: mongoose.Model<t.IUser>;
let sync: ReturnType<typeof createGroupSyncMethods>['syncExternalGroupMemberships'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  Group = mongoose.models.Group || mongoose.model<t.IGroup>('Group', groupSchema);
  User = mongoose.models.User || mongoose.model<t.IUser>('User', userSchema);
  await mongoose.connect(mongoServer.getUri());
  await Group.syncIndexes();
  sync = createGroupSyncMethods(
    mongoose,
    createUserGroupMethods(mongoose),
  ).syncExternalGroupMemberships;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Group.deleteMany({});
  await User.deleteMany({});
});

const newUser = (overrides: Partial<t.IUser> = {}) =>
  User.create({
    name: 'Erin',
    email: `erin-${new Types.ObjectId()}@contoso.test`,
    provider: 'openid',
    ...overrides,
  });

const membersOf = async (idOnTheSource: string) =>
  (await Group.findOne({ idOnTheSource }).lean())?.memberIds ?? [];

describe('syncExternalGroupMemberships', () => {
  it("creates the provider's groups the tenant lacks and adds the user", async () => {
    const erin = await newUser();

    const result = await sync({
      userId: erin._id,
      scope: 'idp1',
      groups: [{ id: 'g-sales' }, { id: 'g-legal', name: 'Legal' }],
    });

    expect(result).toEqual({ joined: 2, left: 0 });
    const groups = await Group.find({ source: 'oidc' }).sort({ idOnTheSource: 1 }).lean();
    expect(groups.map((g) => [g.idOnTheSource, g.name, g.memberIds])).toEqual([
      ['idp1:g-legal', 'Legal', [erin._id.toString()]],
      ['idp1:g-sales', 'g-sales', [erin._id.toString()]],
    ]);
  });

  it('joins existing groups without renaming them, and leaves groups no longer named', async () => {
    const erin = await newUser();
    const finn = await newUser({ name: 'Finn' });
    await Group.create({
      name: 'Sales (renamed by the admin)',
      source: 'oidc',
      idOnTheSource: 'idp1:g-sales',
      memberIds: [finn._id.toString()],
    });
    await sync({ userId: erin._id, scope: 'idp1', groups: [{ id: 'g-sales' }, { id: 'g-legal' }] });

    const result = await sync({ userId: erin._id, scope: 'idp1', groups: [{ id: 'g-sales' }] });

    expect(result).toEqual({ joined: 0, left: 1 });
    expect((await Group.findOne({ idOnTheSource: 'idp1:g-sales' }).lean())?.name).toBe(
      'Sales (renamed by the admin)',
    );
    expect(await membersOf('idp1:g-sales')).toEqual([finn._id.toString(), erin._id.toString()]);
    expect(await membersOf('idp1:g-legal')).toEqual([]);
  });

  it("never touches local groups or another provider's groups", async () => {
    const erin = await newUser();
    const member = erin._id.toString();
    await Group.create([
      { name: 'Board', source: 'local', memberIds: [member] },
      { name: 'Other', source: 'oidc', idOnTheSource: 'idp2:g-x', memberIds: [member] },
      { name: 'Prefix trap', source: 'oidc', idOnTheSource: 'idp10:g-y', memberIds: [member] },
    ]);

    await sync({ userId: erin._id, scope: 'idp1', groups: [] });

    expect((await Group.findOne({ name: 'Board' }).lean())?.memberIds).toEqual([member]);
    expect(await membersOf('idp2:g-x')).toEqual([member]);
    expect(await membersOf('idp10:g-y')).toEqual([member]);
  });

  it("stores the user's external id as the member key when it has one", async () => {
    const erin = await newUser({ idOnTheSource: 'oid-erin' });

    await sync({ userId: erin._id, scope: 'idp1', groups: [{ id: 'g-sales' }] });

    expect(await membersOf('idp1:g-sales')).toEqual(['oid-erin']);
  });

  it('takes at most 200 groups from one sign-in', async () => {
    const erin = await newUser();
    const groups = Array.from({ length: 250 }, (_, i) => ({ id: `g-${i}` }));

    const result = await sync({ userId: erin._id, scope: 'idp1', groups });

    expect(result.joined).toBe(200);
    expect(await Group.countDocuments({ source: 'oidc' })).toBe(200);
  });

  it('refuses an unknown user', async () => {
    await expect(
      sync({ userId: new Types.ObjectId(), scope: 'idp1', groups: [{ id: 'g' }] }),
    ).rejects.toThrow('User not found');
  });
});

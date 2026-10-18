jest.mock("pg", () => ({ Client: jest.fn() }));
const { Client } = require("pg");
const { deleteFixtureAudit, assertAuditCleanupAvailable } = require("../fixtures/adminCleanup");
let client;
beforeEach(() => { process.env.TEST_DATABASE_URL="postgres://test-only"; client={connect:jest.fn().mockResolvedValue(),end:jest.fn().mockResolvedValue(),query:jest.fn().mockResolvedValue({rows:[]})};Client.mockImplementation(()=>client); });
afterEach(()=>{delete process.env.TEST_DATABASE_URL;});
test("[SPM-37] missing cleanup credentials fail before test fixture writes",async()=>{delete process.env.TEST_DATABASE_URL;await expect(assertAuditCleanupAvailable()).rejects.toThrow("TEST_DATABASE_URL");});
test("[SPM-37] cleanup rejects non-fixture profiles and rolls back",async()=>{client.query.mockImplementation(sql=>Promise.resolve({rows:sql.startsWith('SELECT user_id')?[{user_id:11,email:'real@example.com'}]:[]}));await expect(deleteFixtureAudit({runId:'test123',userIds:[11]})).rejects.toThrow('non-fixture');expect(client.query).toHaveBeenCalledWith('ROLLBACK');expect(client.query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);});
test("[SPM-37] audit cleanup uses parameters and exact fixture ownership",async()=>{client.query.mockImplementation(sql=>Promise.resolve({rows:sql.startsWith('SELECT user_id')?[{user_id:11,email:'spm32-test123-user@connectsphere.test'}]:[]}));await deleteFixtureAudit({runId:'test123',userIds:[11]});expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM public.activity_log'),[[11],'spm32-test123-%','spm123-test123-%']);expect(client.query).toHaveBeenCalledWith('COMMIT');expect(client.end).toHaveBeenCalled();});

test("[SPM-37] connection failures do not reveal privileged credentials",async()=>{Client.mockImplementation(()=>{throw new Error('postgres://private-password@database')});await expect(assertAuditCleanupAvailable()).rejects.toThrow('Could not connect to the privileged test database. Check TEST_DATABASE_URL.');});

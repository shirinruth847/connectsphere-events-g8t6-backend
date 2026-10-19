process.env.ENABLE_COORDINATOR_WORKFLOWS = "false";
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
const request = require("supertest");
const app = require("../../app");
test.each([["get","/api/events/unassigned"],["get","/api/events/coordinator-availability"],["get","/api/events/assignments"],["post","/api/events/42/coordinator"],["patch","/api/events/42/coordinator"]])("[NO-TICKET baseline] pending workflow %s %s is unavailable by default", async(method,path)=>{
 const res=await request(app)[method](path);expect(res.status).toBe(404);expect(res.body.code).toBe("NOT_FOUND");
});

jest.mock('../../config/supabase',()=>({rpc:jest.fn()}));
const supabase=require('../../config/supabase');
const eventModel=require('../../model/eventModel');
const command={eventId:42,actorId:21,expectedVersion:7,reason:'Reason text',idempotencyKey:'spm40-key-0001'};
beforeEach(()=>jest.clearAllMocks());
test('[SPM-40] rejection uses one transactional RPC and hashes the reason and version',async()=>{
  supabase.rpc.mockResolvedValue({data:{event:{status:'REJECTED'},replayed:true},error:null});
  expect(await eventModel.rejectSubmittedEvent(command)).toMatchObject({event:{status:'REJECTED'},replayed:true});
  const first=supabase.rpc.mock.calls[0][1];
  expect(first).toMatchObject({p_event_id:42,p_actor_id:21,p_expected_version:7,p_reason:'Reason text',p_idempotency_key:command.idempotencyKey,p_request_hash:expect.stringMatching(/^[0-9a-f]{64}$/)});
  await eventModel.rejectSubmittedEvent({...command,reason:'Another reason'});
  expect(supabase.rpc.mock.calls[1][1].p_request_hash).not.toBe(first.p_request_hash);
});
test('[SPM-40] maps a database refusal and refuses an empty response',async()=>{
  supabase.rpc.mockResolvedValueOnce({data:null,error:{message:'INVALID_REJECTION_REASON',code:'P0001'}});
  await expect(eventModel.rejectSubmittedEvent(command)).rejects.toMatchObject({name:'EventRequestError',code:'INVALID_REJECTION_REASON'});
  supabase.rpc.mockResolvedValueOnce({data:null,error:null});
  await expect(eventModel.rejectSubmittedEvent(command)).rejects.toThrow('returned no event');
});

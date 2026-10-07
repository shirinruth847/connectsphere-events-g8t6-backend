jest.mock('../model/eventModel', () => ({
  findEventById: jest.fn(),
  getUnsupportedInputFields: jest.fn((body, { allowAutoSave = false } = {}) =>
    Object.keys(body).filter(
      (key) => !['title', 'purpose', 'description'].includes(key) && !(allowAutoSave && key === 'isAutoSave')
    )
  ),
  getAllowedLayouts: jest.fn(),
  getAllowedRequirementIds: jest.fn(),
  pickEventInput: jest.fn(),
}));

const eventModel = require('../model/eventModel');
const eventController = require('../controller/eventController');

function createResponse() {
  const response = {};
  response.status = jest.fn(() => response);
  response.json = jest.fn(() => response);
  return response;
}

beforeEach(() => jest.clearAllMocks());

test('another organiser and a missing event both use the owner-scoped 404 path', async () => {
  eventModel.findEventById.mockResolvedValue(null);
  const response = createResponse();

  await eventController.getEventById(
    { params: { id: '42' }, user: { user_id: 17 } },
    response,
    jest.fn()
  );

  expect(eventModel.findEventById).toHaveBeenCalledWith(42, 17);
  expect(response.status).toHaveBeenCalledWith(404);
  expect(response.json).toHaveBeenCalledWith({ message: 'Event request not found.' });
});

test('unsupported request properties fail before any database-dependent validation', async () => {
  eventModel.getUnsupportedInputFields.mockReturnValue(['status']);
  const response = createResponse();

  await eventController.createAndSubmit(
    { body: { title: 'Conference', status: 'SUBMITTED' }, user: { user_id: 17 } },
    response,
    jest.fn()
  );

  expect(response.status).toHaveBeenCalledWith(400);
  expect(response.json).toHaveBeenCalledWith({
    message: 'Please fix the highlighted fields.',
    errors: { _request: 'Unsupported request field(s): status.' },
  });
  expect(eventModel.getAllowedLayouts).not.toHaveBeenCalled();
});
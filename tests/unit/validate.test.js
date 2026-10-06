const { validatePagination } = require("../../middleware/validate");

const runValidatePagination = (query) => {
  const req = { query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  validatePagination(req, res, next);
  return { req, res, next };
};

describe("[TC-AUTH-021] validatePagination", () => {
  test("should_apply_defaults_when_no_paging_parameters_are_sent", () => {
    const { req, next } = runValidatePagination({});

    expect(next).toHaveBeenCalled();
    expect(req.pagination).toEqual({ limit: 50, offset: 0 });
  });

  test.each([
    [{ limit: "1", offset: "0" }, { limit: 1, offset: 0 }],
    [{ limit: "100", offset: "10000" }, { limit: 100, offset: 10000 }],
  ])("should_accept_boundary_values_when_query_is_%j", (query, expected) => {
    const { req, next } = runValidatePagination(query);

    expect(next).toHaveBeenCalled();
    expect(req.pagination).toEqual(expected);
  });

  test.each([
    ["0"], ["101"], ["-1"], ["2.5"], ["ten"], [""], [["10", "20"]],
  ])("should_return_400_when_limit_is_%j", (limit) => {
    const { res, next } = runValidatePagination({ limit });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { limit: "Limit must be a whole number from 1 to 100." },
    });
  });

  test.each([["-1"], ["10001"], ["1e3"]])("should_return_400_when_offset_is_%j", (offset) => {
    const { res } = runValidatePagination({ offset });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].fields).toEqual({ offset: "Offset must be a whole number from 0 to 10000." });
  });

  test("should_report_both_fields_when_limit_and_offset_are_invalid", () => {
    const { res } = runValidatePagination({ limit: "0", offset: "-5" });

    expect(Object.keys(res.json.mock.calls[0][0].fields)).toEqual(["limit", "offset"]);
  });
});

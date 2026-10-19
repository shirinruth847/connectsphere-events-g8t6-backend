const { validatePagination, validateCursorPagination } = require("../../middleware/validate");

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

const runValidateCursorPagination = (query) => {
  const req = { query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  validateCursorPagination(req, res, next);
  return { req, res, next };
};

describe("[TC-AUTH-021] validateCursorPagination", () => {
  test("should_apply_defaults_when_no_paging_parameters_are_sent", () => {
    const { req, next } = runValidateCursorPagination({});

    expect(next).toHaveBeenCalled();
    expect(req.pagination).toEqual({ limit: 50, cursor: null });
  });

  test("should_pass_an_opaque_cursor_through_when_it_is_base64url", () => {
    const { req, next } = runValidateCursorPagination({ limit: "100", cursor: "eyJ1cGRhdGVkQXQiOiJ4In0" });

    expect(next).toHaveBeenCalled();
    expect(req.pagination).toEqual({ limit: 100, cursor: "eyJ1cGRhdGVkQXQiOiJ4In0" });
  });

  test.each([[""], ["has space"], ["a".repeat(257)], [["a", "b"]]])("should_return_400_when_cursor_is_%j", (cursor) => {
    const { res, next } = runValidateCursorPagination({ cursor });

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].fields).toEqual({ cursor: "Invalid page cursor." });
  });

  test("should_reject_offset_so_an_offset_client_cannot_loop_on_page_one_when_list_uses_cursors", () => {
    const { res, next } = runValidateCursorPagination({ offset: "50" });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].fields).toHaveProperty("offset");
  });

  test("should_share_limit_bounds_with_offset_paging_when_limit_is_out_of_range", () => {
    const { res } = runValidateCursorPagination({ limit: "101" });

    expect(res.json.mock.calls[0][0].fields).toEqual({ limit: "Limit must be a whole number from 1 to 100." });
  });
});

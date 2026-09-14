# Commit Message Standard Operating Procedure (SOP) - Backend

To ensure consistency, clarity, and complete traceability across project boards and Git history, all contributors working on the backend must follow the guidelines outlined below when writing commit messages.

---

## **1. Structure of a Commit Message**

Each commit message consists of up to three parts:

1. **Header** (_Required_): A concise, single-line summary containing developer name initials, ticket ID, type, and short description.
   - Limit to **50–72 characters**.
   - Use the imperative mood (e.g., "Add endpoint", "Fix database query" — not "Added" or "Fixes").
2. **Body** (_Required for PRs & complex changes_): Detailed context behind the change.
   - Wrap text at **72 characters**.
   - Focus on **what** was changed and **why** (avoid explaining _how_ unless necessary).
3. **Footer** (_Optional_): References to issue tracking tickets, breaking changes, or co-authors.

---

## **2. Commit Header Format**

```text
[<name-prefix>][<ticket-id>][<type>] <summary>
```

### **Format Breakdown**

| Field             | Description                                                                                  | Example                             |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| **`name-prefix`** | The contributor's initials or identifier (in uppercase).                                     | `JD` (John Doe), `AS` (Alice Smith) |
| **`ticket-id`**   | The issue tracker ID associated with the task/bug. Use `NO-TICKET` for quick chores or docs. | `SPM-55`, `SPM-58`                  |
| **`type`**        | The category describing the nature of the change (all caps).                                 | `FEAT`, `FIX`                       |
| **`summary`**     | Concise summary starting with an imperative verb.                                            | `add user authentication endpoint`  |

---

## **3. Commit Types**

| Type           | When to Use                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **`FEAT`**     | Introducing a new backend feature, API endpoint, or service module.                            |
| **`FIX`**      | Resolving a server bug, database query error, or API issue.                                    |
| **`DOCS`**     | Adding or updating backend documentation (e.g., API docs, `README.md`).                        |
| **`STYLE`**    | Code style/linting fixes with no business logic impact.                                        |
| **`REFACTOR`** | Restructuring backend controllers, services, or DB models without changing behavior.           |
| **`TEST`**     | Adding, updating, or fixing backend unit/integration tests.                                    |
| **`CHORE`**    | Maintenance tasks (npm dependencies, database migrations config, environment variables setup). |
| **`PERF`**     | Database indexing, query optimization, or caching improvements.                                |

---

## **4. Examples**

### **Feature Commit (With Ticket ID)**

```text
[SR][SPM-55][FEAT] initialize Node.js backend boilerplate application
```

### **Bug Fix Commit (With Ticket ID)**

```text
[AS][SPM-58][FIX] configure CORS headers to allow cross-origin requests from frontend
```

### **Documentation Update (No Specific Ticket)**

```text
[JD][NO-TICKET][DOCS] add setup instructions to backend README
```

### **Full Commit (Header + Body + Footer)**

```text
[JD][SPM-58][FIX] configure CORS middleware for frontend connection

Added proper origin rules and exposed required headers to enable
secure communication between the React frontend and Node backend.

Closes SPM-58
```

---

## **5. Standard Operating Guidelines & Rules**

1. **Include Name Initials & Ticket IDs**: Always attach your name prefix (e.g., `[JD]`) and valid issue key (e.g., `[SPM-55]`) for author recognition and board traceability.
2. **Atomic Commits**: Keep commits small and focused on a single logical change. Do not bundle unrelated changes together.
3. **Imperative Mood**: Write the summary as a command (e.g., "Add route handler" instead of "Added route handler").
4. **Pre-Commit Self-Review**: Run `git diff` and verify your API tests pass before executing `git commit`.

---

This SOP is strictly enforced for all pull requests merged into `main`.

# FDN G15 official device MCP production resource/privacy evidence

This slice measures the real shipping `fabushi-fdn-official-device-mcp.service`, not an injected `accountClient` or a mock MCP server.

The production probe is valid only when the controller's deployed `BACKEND_SHA` equals the workflow exact main SHA and its `CORE_SHA` equals the verified current Platform Core main SHA. It samples five minutes of the live Node process and enforces RSS < 150 MiB, single-core average CPU < 1%, state/audit/journal <= 20 MiB, and filesystem free space >= max(1 GiB, 5%). It scans only journal output for credential-like material; it never copies the MCP state file because that file intentionally contains local OAuth state.

The service has `MemoryMax=150M` and `TasksMax=256`. Full privacy promotion additionally requires a production egress rejection counter owned by an OUTPUT firewall rule tagged `fdn-g15-official-device-mcp-egress`. Until that real owner exists, the production probe exits 78 with `BLOCKED_EGRESS_REJECT_COUNTER`; this must not be recorded as passed G15 evidence.

Pull-request CI validates only the exact shipping process/service contract and probe syntax. Real resource evidence can only come from a workflow-dispatch run on deployed exact main with the production environment.

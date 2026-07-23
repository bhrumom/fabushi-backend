import http from 'node:http';

const port = Number(process.env.PORT || 8790);

const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const toolOutput = (payload.messages || []).find((message) => message.role === 'tool');
    const readTool = (payload.tools || []).find(
      (tool) => tool?.function?.name === 'mahayana__read_workspace_file',
    );
    process.stdout.write(`${JSON.stringify({
      messageCount: payload.messages?.length || 0,
      toolCount: payload.tools?.length || 0,
      hasReadTool: Boolean(readTool),
      hasToolOutput: Boolean(toolOutput),
    })}\n`);
    const message = toolOutput
      ? {
          role: 'assistant',
          content: '已通过机器人之父的 Codex 工作区工具读取真实插件清单。',
        }
      : readTool
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_read_manifest',
              type: 'function',
              function: {
                name: readTool.function.name,
                arguments: JSON.stringify({
                  path: '.agents/plugins/plugins/chatgpt-auto-confirm/.codex-plugin/plugin.json',
                }),
              },
            }],
          }
        : {
            role: 'assistant',
            content: '测试失败：DeepSeek 请求没有包含机器人之父工作区工具。',
          };

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'deepseek-test-response',
      model: payload.model || 'deepseek-chat',
      choices: [{ index: 0, finish_reason: toolOutput ? 'stop' : 'tool_calls', message }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }));
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake DeepSeek listening on ${port}\n`);
});

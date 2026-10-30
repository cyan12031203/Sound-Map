export class ToolRunner {
  constructor(tools, { timeoutMs = 2000 } = {}) {
    this.tools = tools;
    this.timeoutMs = timeoutMs;
  }

  async call(name, input) {
    const tool = this.tools[name];
    if (!tool) throw new Error(`Agent 请求了不存在的工具：${name}`);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => tool(input)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`工具 ${name} 超时。`)), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

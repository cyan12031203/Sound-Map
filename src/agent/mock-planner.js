// 第一阶段使用的可预测决策器。第二阶段会替换成真实 LLM，Agent 内核无需重写。
export class MockPlanner {
  async plan({ iteration, previousEvaluation }) {
    if (iteration === 1) {
      return {
        summary: '先用主导场景筛选歌曲，再请时长工具提出组合。',
        introduction: '让音乐跟着沿途的光，在这段路程里慢慢展开。',
        search: { energy_range: [0.35, 0.8], max_duration: 420 },
        use_dp: true,
        revision_hint: '如果时长不合格，我会扩大能量范围后重选。',
      };
    }
    return {
      summary: previousEvaluation?.duration_ok
        ? '时长已经合格，保留当前组合。'
        : '上一轮时长未达标，本轮放宽筛选范围重新配平。',
      introduction: '为你重新整理了这段旅程的节奏，让光影和音乐一起向前。',
      search: { energy_range: [0.15, 0.95], max_duration: 480 },
      use_dp: true,
      revision_hint: '继续保留最接近路线时长的组合。',
    };
  }
}

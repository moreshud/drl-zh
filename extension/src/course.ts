// Course metadata: chapter titles + per-chapter "what the student is working
// on right now" context snippets. Shared across ContextTracker (parsing the
// notebook filename → chapter number) and the LLM system prompt (injecting
// the TOC in meta-mode + the current chapter's context block during a
// notebook session).

export const CHAPTER_TITLES: Record<number, string> = {
  0: 'Introduction', 1: 'MDP', 2: 'RL Foundations', 3: 'Deep Q-Learning',
  4: 'Policy Gradient', 5: 'Actor-Critic', 6: 'PPO', 7: 'Bridge to Advanced Topics',
  8: 'Exploration & Curiosity', 9: 'Multi-Agent RL', 10: 'Offline RL',
  11: 'MCTS & AlphaZero', 12: 'RLHF', 13: 'Decision Transformers & VLA',
  14: 'Productionizing RL', 15: 'Model-Based RL', 16: 'Dreamer',
  17: 'Meta-Learning', 18: 'Course Conclusion',
};

export const CHAPTER_CONTEXT: Record<number, string> = {
  0:  'Introduction to RL. Student is getting oriented.',
  1:  'Markov Decision Processes. Key concepts: states, actions, transitions, rewards, discount factor γ.',
  2:  'RL Foundations. Key concepts: agent, environment, policy, value function, Q-function.',
  3:  'Deep Q-Learning (DQN). Key concepts: Q-table, experience replay, target network, epsilon-greedy.',
  4:  'Policy Gradient. Key concepts: REINFORCE, log-probability, Monte Carlo returns.',
  5:  'Actor-Critic. Key concepts: advantage function, baseline, critic network.',
  6:  'PPO. Key concepts: clipped surrogate objective, old vs new policy, KL divergence.',
  7:  'Bridge chapter. Student is transitioning from the foundations to advanced topics.',
  8:  'Exploration & Curiosity. Key concepts: intrinsic reward, curiosity module, count-based exploration.',
  9:  'Multi-Agent RL. Key concepts: cooperative vs competitive, Nash equilibrium, CTDE.',
  10: 'Offline RL. Key concepts: behavioral cloning, IQL, fixed dataset, distribution shift.',
  11: 'MCTS & AlphaZero. Key concepts: UCB1, tree search, self-play, policy/value network.',
  12: 'RLHF. Key concepts: reward heuristic, PPO fine-tuning, KL penalty, DPO/GRPO.',
  13: 'Decision Transformers & Vision-Language-Action models. Key concepts: return-to-go, sequence modeling, offline RL via transformers.',
  14: 'Productionizing RL. Key concepts: eval environments, reward shaping, deployment, monitoring.',
  15: 'Model-Based RL. Key concepts: world model, MBPO, Dyna, predictive ensemble.',
  16: 'Dreamer. Key concepts: RSSM, latent imagination, two-hot reward head, continuation prediction.',
  17: 'Meta-Learning. Key concepts: MAML, learning to learn, task distribution, fast adaptation.',
  18: 'Course conclusion.',
};

/**
 * Render the full course TOC as a prompt-friendly string. Used by the
 * meta-mode system prompt so Zee can answer "which chapter should I start
 * with?" without fabricating chapter names.
 */
export function buildCourseTOC(): string {
  const chapters = Object.keys(CHAPTER_TITLES)
    .map(n => parseInt(n, 10))
    .sort((a, b) => a - b);
  return chapters.map(n => {
    const title = CHAPTER_TITLES[n];
    const ctx = CHAPTER_CONTEXT[n] ?? '';
    return `Chapter ${n} — ${title}: ${ctx}`;
  }).join('\n');
}

import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show usage by provider/profile',
  load: () => import('./usage.js'),
} satisfies Command

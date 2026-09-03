import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'computer-history-mcp',
  description: 'Local-first MCP server for Screenpipe memory and automation workflows.',
  base: '/computer-history-mcp/',
  srcExclude: [
    'agents/**',
    'archives/**',
    'architecture.md',
    'develop_log.md',
    'architecture/**',
    'clients/**',
    'delivery/**',
    'documentation/**',
    'engineering/**',
    'plan/**',
    'security/**',
    'specs/**',
    'superpowers/**',
  ],
  themeConfig: {
    socialLinks: [{ icon: 'github', link: 'https://github.com/xiaozhenliu/computer-history-mcp' }],
    search: { provider: 'local' },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/introduction' },
          { text: 'Reference', link: '/reference/tools' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Introduction', link: '/guide/introduction' },
                { text: 'Quickstart', link: '/guide/quickstart' },
                {
                  text: 'Connect Clients',
                  items: [
                    { text: 'Claude Code & Desktop', link: '/guide/clients/claude-code' },
                    { text: 'Cursor', link: '/guide/clients/cursor' },
                    { text: 'Hermes', link: '/guide/clients/hermes' },
                    { text: 'Generic MCP Client', link: '/guide/clients/generic-mcp' },
                  ],
                },
                { text: 'Operations', link: '/guide/operations' },
                { text: 'Routines', link: '/guide/routines' },
                { text: 'Troubleshooting', link: '/guide/troubleshooting' },
              ],
            },
          ],
          '/reference/': [
            {
              text: 'Reference',
              items: [
                { text: 'MCP Tools', link: '/reference/tools' },
                { text: 'Configuration', link: '/reference/configuration' },
                { text: 'Dashboard', link: '/reference/dashboard' },
                { text: 'Privacy & Data', link: '/reference/privacy' },
              ],
            },
          ],
        },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/introduction' },
          { text: '参考', link: '/zh/reference/tools' },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '指南',
              items: [
                { text: '介绍', link: '/zh/guide/introduction' },
                { text: '快速开始', link: '/zh/guide/quickstart' },
                {
                  text: '接入客户端',
                  items: [
                    { text: 'Claude Code 与 Desktop', link: '/zh/guide/clients/claude-code' },
                    { text: 'Cursor', link: '/zh/guide/clients/cursor' },
                    { text: 'Hermes', link: '/zh/guide/clients/hermes' },
                    { text: '通用 MCP 客户端', link: '/zh/guide/clients/generic-mcp' },
                  ],
                },
                { text: '日常运维', link: '/zh/guide/operations' },
                { text: 'Routines', link: '/zh/guide/routines' },
                { text: '排障', link: '/zh/guide/troubleshooting' },
              ],
            },
          ],
          '/zh/reference/': [
            {
              text: '参考',
              items: [
                { text: 'MCP 工具', link: '/zh/reference/tools' },
                { text: '配置文件', link: '/zh/reference/configuration' },
                { text: '控制面板', link: '/zh/reference/dashboard' },
                { text: '隐私与数据', link: '/zh/reference/privacy' },
              ],
            },
          ],
        },
      },
    },
  },
})

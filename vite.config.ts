import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/app.db*',
        '**/dist/**',
        '**/dist-electron/**',
        '**/release/**',
        '**/user-data/**',
      ],
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](?:react|react-dom)[\\/]/,
            },
            {
              name: 'terminal-vendor',
              test: /node_modules[\\/]@xterm[\\/]/,
            },
            {
              name: 'antd-icons',
              test: /node_modules[\\/]@ant-design[\\/]icons[\\/]/,
            },
            {
              name: 'antd-data-entry',
              test: /node_modules[\\/]antd[\\/]es[\\/](?:form|input|input-number|select|tree-select|checkbox|switch)[\\/]/,
            },
            {
              name: 'antd-data-display',
              test: /node_modules[\\/]antd[\\/]es[\\/](?:table|tree|list|menu|dropdown|tabs|tag|badge|empty|progress|tooltip|popover)[\\/]/,
            },
            {
              name: 'antd-feedback',
              test: /node_modules[\\/]antd[\\/]es[\\/](?:modal|message|notification|alert|popconfirm)[\\/]/,
            },
            {
              name: 'antd-core',
              test: /node_modules[\\/]antd[\\/]/,
            },
            {
              name: 'rc-vendor',
              test: /node_modules[\\/](?:@rc-component|rc-[^\\/]+)[\\/]/,
            },
          ],
        },
      },
    },
  },
});

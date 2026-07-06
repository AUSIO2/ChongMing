import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@flow-map': path.resolve(__dirname, 'src/flow-map'),
      '@chrome': path.resolve(__dirname, 'src/chrome'),
      '@tests': path.resolve(__dirname, 'tests'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
})

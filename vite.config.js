import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Two pages: the spotting app, and the admin page that generates links into it.
// They share the Frame.io layer and the session codec, so this is a multi-page
// build rather than a router — no route table, and each page loads only what it
// needs (the admin page never pulls in ffmpeg).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main:  resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Auto-open the browser when running `npm run dev` or `npm run preview`.
  server: { open: true },
  preview: { open: true },
})

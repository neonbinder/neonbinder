module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'neon-green': '#00D558',    // Primary
        'neon-pink': '#FF2E9A',     // Destructive / Cancel
        'neon-yellow': '#FFE600',   // Warning / Accent
        'neon-blue': '#00C2FF',     // Info / Accent
        'neon-purple': '#A44AFF',   // Tabs / UI
        'neon-orange': '#FF9E00',   // Admin / gated features
        background: {
          DEFAULT: '#000000',  // Main background
        },
        text: {
          DEFAULT: '#FFFFFF',  // Main text
        }
      },
      fontFamily: {
        sans: ['Lexend', 'sans-serif'],
      },
    },
  },
  plugins: [],
} 
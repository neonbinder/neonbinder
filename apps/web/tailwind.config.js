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
        // Tabs / UI. DEFAULT (#A44AFF) is for fills, borders, rings and
        // glows. TEXT uses `text-neon-purple-text` (#B56BFF, same 270° hue,
        // a touch lighter): #A44AFF is only 4.23:1 on gray-900 and 3.5:1 on
        // gray-800 (SC 1.4.3 needs 4.5:1); #B56BFF is 5.5:1 and 4.55:1.
        'neon-purple': {
          DEFAULT: '#A44AFF',
          text: '#B56BFF',
        },
        'neon-orange': '#FF9E00',   // Admin / gated features
        'neon-teal': '#00E5C0',     // Shipping / labels
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
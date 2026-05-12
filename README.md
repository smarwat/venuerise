# VenueRise — AI Revenue Operations Landing Page

Premium Next.js landing page for VenueRise, an AI-powered revenue operations system for wedding venues.

## Tech Stack

- **Next.js 14** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **Framer Motion** (animations)
- **Lucide React** (icons)
- Google Fonts: Inter + Playfair Display

## Setup

**Requires Node.js 18+.** Install via [nodejs.org](https://nodejs.org) or `brew install node` if you have Homebrew.

```bash
cd venuerise
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Build for production

```bash
npm run build
npm start
```

## Project Structure

```
venuerise/
├── app/
│   ├── globals.css       # Tailwind base + custom utilities
│   ├── layout.tsx        # Root layout with fonts and metadata
│   └── page.tsx          # Main page (assembles all sections)
├── components/
│   ├── Navbar.tsx        # Sticky nav with mobile menu
│   ├── Hero.tsx          # Hero with floating mock UI cards
│   ├── SocialProof.tsx   # Stats strip + venue type marquee
│   ├── PainPoints.tsx    # 5 pain point cards
│   ├── Solution.tsx      # 6 solution feature cards
│   ├── HowItWorks.tsx    # 4-step process timeline
│   ├── ROI.tsx           # Metric cards + ROI callout
│   ├── DemoPreview.tsx   # Animated inquiry-to-booking flow
│   ├── Differentiation.tsx # Comparison table + feature list
│   ├── FinalCTA.tsx      # Conversion section
│   └── Footer.tsx        # Footer with links
├── tailwind.config.ts
├── next.config.js
└── tsconfig.json
```

## Design System

| Token | Value |
|-------|-------|
| Background | `#0A0A0B` |
| Surface | `#0D0D10` |
| Ivory text | `#F5F0E8` |
| Champagne gold | `#C9A96E` |
| Gold light | `#D4B896` |
| Muted text | `rgba(245,240,232,0.45)` |
| Card border | `rgba(255,255,255,0.08)` |
| Gold border | `rgba(201,169,110,0.20)` |

## Customization

- **Colors**: Edit `tailwind.config.ts` and the CSS variables in `app/globals.css`
- **Content**: All copy lives directly in each component file
- **Fonts**: Swap `Playfair_Display` / `Inter` in `app/layout.tsx`
- **CTA links**: Update `href` values in `FinalCTA.tsx`, `Navbar.tsx`, and `Footer.tsx`

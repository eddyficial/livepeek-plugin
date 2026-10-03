/**
 * Viewport catalogue.
 *
 * `w` / `h` are CSS viewport sizes in logical pixels — the numbers your
 * layout code actually sees. For real devices they are the practical values
 * reported by that device's browser, rounded to whole pixels; treat them as
 * close approximations, not spec-sheet truth. The viewer always prints the
 * exact figures it is using in the footer.
 *
 * `frame` decides what gets drawn around the viewport:
 *   'phone'  a phone body with bezel, corner radius and camera cutout
 *   'none'   the viewport on a flat matte - for web and games, where a phone
 *            bezel would be a lie about what you are building
 *
 * Phone-only fields, ignored when frame is 'none':
 *   `dpr`   device pixel ratio
 *   `r`     screen corner radius in logical px
 *   `cut`   'island' | 'notch' | 'hole' | 'none'
 *   `chin`  true for devices with a physical home button / top+bottom bezel
 *
 * To add an entry, append it. No other file needs to change.
 */
window.PRESETS = [
  // ---- iPhone ----------------------------------------------------------
  { id: 'iphone-17-pro-max', name: 'iPhone 17 Pro Max', brand: 'iPhone', os: 'iOS',     w: 440, h: 956, dpr: 3, r: 55, cut: 'island' },
  { id: 'iphone-17-pro',     name: 'iPhone 17 Pro',     brand: 'iPhone', os: 'iOS',     w: 402, h: 874, dpr: 3, r: 55, cut: 'island' },
  { id: 'iphone-17',         name: 'iPhone 17',         brand: 'iPhone', os: 'iOS',     w: 402, h: 874, dpr: 3, r: 55, cut: 'island' },
  { id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', brand: 'iPhone', os: 'iOS',     w: 440, h: 956, dpr: 3, r: 55, cut: 'island' },
  { id: 'iphone-15-pro',     name: 'iPhone 15 Pro',     brand: 'iPhone', os: 'iOS',     w: 393, h: 852, dpr: 3, r: 50, cut: 'island' },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', brand: 'iPhone', os: 'iOS',     w: 430, h: 932, dpr: 3, r: 53, cut: 'island' },
  { id: 'iphone-14',         name: 'iPhone 13 / 14',    brand: 'iPhone', os: 'iOS',     w: 390, h: 844, dpr: 3, r: 47, cut: 'notch' },
  { id: 'iphone-13-mini',    name: 'iPhone 13 mini',    brand: 'iPhone', os: 'iOS',     w: 375, h: 812, dpr: 3, r: 44, cut: 'notch' },
  { id: 'iphone-se',         name: 'iPhone SE (3rd gen)', brand: 'iPhone', os: 'iOS',   w: 375, h: 667, dpr: 2, r: 4,  cut: 'none', chin: true },

  // ---- Pixel -----------------------------------------------------------
  { id: 'pixel-9-pro-xl',    name: 'Pixel 9 Pro XL',    brand: 'Pixel',  os: 'Android', w: 448, h: 998, dpr: 2.625, r: 42, cut: 'hole' },
  { id: 'pixel-9-pro',       name: 'Pixel 9 Pro',       brand: 'Pixel',  os: 'Android', w: 428, h: 952, dpr: 2.625, r: 42, cut: 'hole' },
  { id: 'pixel-9',           name: 'Pixel 8 / 9',       brand: 'Pixel',  os: 'Android', w: 412, h: 915, dpr: 2.625, r: 38, cut: 'hole' },
  { id: 'pixel-7a',          name: 'Pixel 7a',          brand: 'Pixel',  os: 'Android', w: 412, h: 892, dpr: 2.625, r: 32, cut: 'hole' },

  // ---- Galaxy ----------------------------------------------------------
  { id: 'galaxy-s24-ultra',  name: 'Galaxy S24 Ultra',  brand: 'Galaxy', os: 'Android', w: 384, h: 824, dpr: 3.75, r: 26, cut: 'hole' },
  { id: 'galaxy-s24',        name: 'Galaxy S23 / S24',  brand: 'Galaxy', os: 'Android', w: 360, h: 780, dpr: 3,    r: 36, cut: 'hole' },
  { id: 'galaxy-a54',        name: 'Galaxy A54',        brand: 'Galaxy', os: 'Android', w: 360, h: 800, dpr: 3,    r: 28, cut: 'hole' },
  { id: 'galaxy-fold-open',  name: 'Galaxy Z Fold (open)', brand: 'Galaxy', os: 'Android', w: 673, h: 841, dpr: 2.625, r: 24, cut: 'hole' },

  // ---- Small / legacy --------------------------------------------------
  { id: 'android-small',     name: 'Small Android (360×640)', brand: 'Other', os: 'Android', w: 360, h: 640, dpr: 2, r: 20, cut: 'none' },

  // ---- Tablets ---------------------------------------------------------
  { id: 'ipad-mini',         name: 'iPad mini',         brand: 'Tablet', os: 'iPadOS',  w: 744, h: 1133, dpr: 2, r: 32, cut: 'none' },
  { id: 'ipad-pro-11',       name: 'iPad Pro 11"',      brand: 'Tablet', os: 'iPadOS',  w: 834, h: 1194, dpr: 2, r: 32, cut: 'none' },

  // ---- Web -------------------------------------------------------------
  // 'fit' renders at the pane's own pixel size, so nothing is scaled down and
  // text stays crisp. The viewer fills in w/h from the pane; 0 here is a
  // placeholder. Fixed sizes below are shrunk to fit and read as small text.
  { id: 'fit',               name: 'Fit to pane (crisp)', brand: 'Web', os: 'Web', w: 0, h: 0, frame: 'none', fit: true },
  // No bezel: a browser viewport is the thing being built, and wrapping it
  // in a phone body would misrepresent it. The breakpoints are the common
  // CSS ones rather than physical screen sizes.
  { id: 'desktop',           name: 'Desktop 1440',      brand: 'Web', os: 'Web', w: 1440, h: 900,  frame: 'none' },
  { id: 'desktop-wide',      name: 'Desktop 1920',      brand: 'Web', os: 'Web', w: 1920, h: 1080, frame: 'none' },
  { id: 'laptop',            name: 'Laptop 1280',       brand: 'Web', os: 'Web', w: 1280, h: 800,  frame: 'none' },
  { id: 'laptop-small',      name: 'Laptop 1024',       brand: 'Web', os: 'Web', w: 1024, h: 768,  frame: 'none' },
  { id: 'tablet-web',        name: 'Tablet 768',        brand: 'Web', os: 'Web', w: 768,  h: 1024, frame: 'none' },
  { id: 'mobile-web',        name: 'Mobile 390',        brand: 'Web', os: 'Web', w: 390,  h: 844,  frame: 'none' },

  // ---- Document --------------------------------------------------------
  // A page-shaped viewport for things that are read rather than used: a
  // README, a spec, a mockup. Tall, so a document scrolls like a document.
  { id: 'document',          name: 'Document',          brand: 'Document', os: 'Page', w: 900,  h: 1200, frame: 'none' },
  { id: 'document-wide',     name: 'Document wide',     brand: 'Document', os: 'Page', w: 1200, h: 1000, frame: 'none' },

  // ---- Game ------------------------------------------------------------
  // Fixed aspect ratios rather than device sizes - what matters for a canvas
  // is the shape, and the terminal pane scales it to fit.
  { id: 'game-720p',         name: 'Game 16:9 720p',    brand: 'Game', os: 'Canvas', w: 1280, h: 720,  frame: 'none' },
  { id: 'game-1080p',        name: 'Game 16:9 1080p',   brand: 'Game', os: 'Canvas', w: 1920, h: 1080, frame: 'none' },
  { id: 'game-4-3',          name: 'Game 4:3',          brand: 'Game', os: 'Canvas', w: 1024, h: 768,  frame: 'none' },
  { id: 'game-square',       name: 'Game 1:1',          brand: 'Game', os: 'Canvas', w: 800,  h: 800,  frame: 'none' },
  { id: 'game-portrait',     name: 'Game 9:16',         brand: 'Game', os: 'Canvas', w: 720,  h: 1280, frame: 'none' },
];

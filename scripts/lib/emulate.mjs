/**
 * What a device preset tells the page about itself, beyond its size.
 *
 * A phone preset that only resizes the viewport still says "Windows, Chrome,
 * mouse" to the page, so anything that checks for an iPhone or a touch screen
 * (an "Add to Home Screen" hint, a mobile layout chosen by user agent, touch
 * handlers) behaves as on a desktop. These are applied over CDP, which, unlike
 * a Playwright context option, can change while the page is open.
 */

/** Safari 26 on iOS reports its OS as 18_6 and its own version as 26.0. */
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
/** Safari on an iPad asks for desktop sites, so it says it is a Mac; touch is the tell. */
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/**
 * The identity for a preset, or null for web, game and document presets,
 * which show the browser as it is. `chromeMajor` is the driving browser's
 * major version, so an Android preset claims the engine actually rendering.
 */
export function deviceProfile(d, chromeMajor = '140') {
  if (d.os === 'iOS') return { userAgent: IOS_UA, platform: 'iPhone', mobile: true, touchPoints: 5 };
  if (d.os === 'iPadOS') return { userAgent: IPAD_UA, platform: 'MacIntel', mobile: false, touchPoints: 5 };
  if (d.os === 'Android') {
    const model = d.name.replace(/^(Google|Samsung) /, '');
    return {
      // Chrome on Android reduces its user agent to this fixed shape.
      userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv81',
      mobile: true,
      touchPoints: 5,
      metadata: {
        brands: [{ brand: 'Chromium', version: chromeMajor }, { brand: 'Google Chrome', version: chromeMajor }, { brand: 'Not?A_Brand', version: '99' }],
        platform: 'Android',
        platformVersion: '15.0.0',
        architecture: '',
        model,
        mobile: true,
      },
    };
  }
  return null;
}

/**
 * Applies the preset's identity to a page through its CDP session, or clears
 * it. `viewport` and `scale` repeat what the viewer set, because the mobile
 * flag (overlay scrollbars, the page's own viewport meta honoured) rides on
 * the same metrics call that Playwright makes without it.
 */
export async function applyDeviceProfile(cdp, profile, viewport, scale) {
  if (!profile) {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    return;
  }
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: profile.userAgent,
    platform: profile.platform,
    ...(profile.metadata ? { userAgentMetadata: profile.metadata } : {}),
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: profile.touchPoints });
  if (profile.mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: scale,
      mobile: true,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
  }
}

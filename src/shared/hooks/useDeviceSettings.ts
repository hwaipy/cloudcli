import { useEffect, useState } from 'react';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
  trackTouch?: boolean;
};

const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < mobileBreakpoint;
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

const getHasTouchInput = (): boolean => (
  typeof window !== 'undefined' && (
    window.navigator.maxTouchPoints > 0 ||
    window.matchMedia('(any-pointer: coarse)').matches
  )
);

/** Used by workspace, settings, sidebar and shell to track layout, installation and input capabilities independently. */
export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    trackMobile = true,
    trackPWA = true,
    trackTouch = false,
  } = options;

  // Layout follows the available width even when a wide device also accepts touch input.
  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  // Installation status controls the sidebar's standalone-app presentation.
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));
  // Input controls need touch capability independently of the desktop/mobile layout breakpoint.
  const [hasTouchInput, setHasTouchInput] = useState<boolean>(() => (
    trackTouch ? getHasTouchInput() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    const checkMobile = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, [mobileBreakpoint, trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  useEffect(() => {
    if (!trackTouch || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(any-pointer: coarse)');
    const checkTouchInput = () => setHasTouchInput(getHasTouchInput());
    checkTouchInput();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkTouchInput);
      return () => mediaQuery.removeEventListener('change', checkTouchInput);
    }

    mediaQuery.addListener(checkTouchInput);
    return () => mediaQuery.removeListener(checkTouchInput);
  }, [trackTouch]);

  return { isMobile, isPWA, hasTouchInput };
}

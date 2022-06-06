import type { Csp } from '../../types'

export const csp: Csp = {
  'connect-src': [
    'wss://*.bridge.walletconnect.org/',
    'https://registry.walletconnect.com/api/v2/wallets',
    'https://imagedelivery.net/',
  ],
}

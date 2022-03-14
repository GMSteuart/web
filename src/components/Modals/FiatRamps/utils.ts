import { adapters } from '@shapeshiftoss/caip'
import axios from 'axios'
import { getConfig } from 'config'
import { concat, flatten, uniqBy } from 'lodash'
import memoize from 'lodash/memoize'
import { matchSorter } from 'match-sorter'
import queryString from 'querystring'
import { bnOrZero } from 'lib/bignumber/bignumber'

import { FiatRampAction, GemCurrency, SupportedCurrency, TransactionDirection } from './FiatRamps'

const ASSET_LOGO_BASE_URI =
  'https://gem-widgets-assets.s3-us-west-2.amazonaws.com/currencies/crypto/'

export const middleEllipsis = (address: string, cut: number) =>
  `${address.slice(0, cut)}...${address.slice(-1 * cut)}`

export const isSupportedBitcoinAsset = (ticker: string | undefined) =>
  Boolean(ticker && ticker === 'BTC')

export const getAssetLogoUrl = (asset: GemCurrency) => {
  return ASSET_LOGO_BASE_URI + asset.ticker.toLowerCase() + '.svg'
}

export const filterAssetsBySearchTerm = (search: string, assets: GemCurrency[]) => {
  if (!assets) return []

  return matchSorter(assets, search, { keys: ['name', 'ticker'] })
}

export const fetchCoinifySupportedCurrencies = async (): Promise<SupportedCurrency[]> => {
  try {
    const { data } = await axios.get(getConfig().REACT_APP_GEM_COINIFY_SUPPORTED_COINS)
    return data
  } catch (e: any) {
    console.error(e)
    return []
  }
}

export const fetchWyreSupportedCurrencies = async (): Promise<SupportedCurrency[]> => {
  try {
    const { data } = await axios.get(getConfig().REACT_APP_GEM_WYRE_SUPPORTED_COINS)
    return data
  } catch (e: any) {
    console.error(e)
    return []
  }
}

export const isBuyAsset = (currency: SupportedCurrency) =>
  currency.transaction_direction === TransactionDirection.BankToBlockchain ||
  currency.transaction_direction === TransactionDirection.CardToBlockchain

export const isSellAsset = (currency: SupportedCurrency) =>
  currency.transaction_direction === TransactionDirection.BlockchainToBank

export const parseGemSellAssets = (
  coinifyAssets: SupportedCurrency[],
  wyreAssets: SupportedCurrency[],
  balances: any,
  btcAddress: string
): GemCurrency[] =>
  parseGemAssets(
    coinifyAssets.filter(isSellAsset).map(coinifyList => coinifyList['source'].currencies),
    wyreAssets.filter(isSellAsset).map(wyreList => wyreList['source'].currencies),
    'source',
    balances,
    btcAddress
  )

export const parseGemBuyAssets = (
  coinifyAssets: SupportedCurrency[],
  wyreAssets: SupportedCurrency[],
  balances: any,
  btcAddress: string
): GemCurrency[] =>
  parseGemAssets(
    coinifyAssets.filter(isBuyAsset).map(coinifyList => coinifyList['destination'].currencies),
    wyreAssets.filter(isBuyAsset).map(wyreList => wyreList['destination'].currencies),
    'source',
    balances,
    btcAddress
  )

export const parseGemAssets = (
  filteredCoinifyList: GemCurrency[][],
  filteredWyreList: GemCurrency[][],
  key: 'destination' | 'source',
  balances: any,
  btcAddress: string
): GemCurrency[] => {
  const results = uniqBy(flatten(concat(filteredCoinifyList, filteredWyreList)), 'gem_asset_id')
    .filter(asset => Boolean(adapters.gemTickerToCAIP19(asset.ticker)))
    .map(asset => {
      return {
        ...asset,
        disabled: isSupportedBitcoinAsset(asset?.ticker) && !btcAddress,
        cryptoBalance: bnOrZero(balances[asset?.ticker]?.crypto),
        fiatBalance: bnOrZero(balances[asset?.ticker]?.fiat)
      }
    })
    .sort((a, b) =>
      key === 'source' && (a.fiatBalance || b.fiatBalance)
        ? b.fiatBalance.minus(a.fiatBalance).toNumber()
        : a.name.localeCompare(b.name)
    )
  return results
}

export const makeGemPartnerUrl = memoize(
  (intent: FiatRampAction, selectedAssetTicker: string | undefined, address: string) => {
    if (!selectedAssetTicker) return

    const GEM_URL = getConfig().REACT_APP_GEM_URL
    const partnerName = 'ShapeShift'
    const environment = getConfig().REACT_APP_GEM_ENV
    const partnerIconUrl =
      'https://portis-prod.s3.amazonaws.com/assets/dapps-logo/191330a6-d761-4312-9fa5-7f0024483302.png'
    const apiKey = getConfig().REACT_APP_GEM_API_KEY
    const onrampConfig = {
      partnerName,
      environment,
      partnerIconUrl,
      apiKey
    }
    const queryConfig = queryString.stringify({
      ...onrampConfig,
      intent,
      wallets: JSON.stringify([{ address, asset: selectedAssetTicker }])
    })
    return `${GEM_URL}?${queryConfig}`
  }
)

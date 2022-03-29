import { createSlice } from '@reduxjs/toolkit'
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/dist/query/react'
import { AssetNamespace, CAIP2, caip2, caip10, CAIP19, caip19 } from '@shapeshiftoss/caip'
import { foxyAddresses, FoxyApi, RebaseHistory } from '@shapeshiftoss/investor-foxy'
import { chainAdapters, ChainTypes, NetworkTypes, UtxoAccountType } from '@shapeshiftoss/types'
import { getConfig } from 'config'
import isEmpty from 'lodash/isEmpty'
import orderBy from 'lodash/orderBy'
import { getChainAdapters } from 'context/PluginProvider/PluginProvider'
import {
  AccountSpecifier,
  AccountSpecifierMap
} from 'state/slices/accountSpecifiersSlice/accountSpecifiersSlice'

import { addToIndex, getRelatedAssetIds } from './utils'

export type TxId = string
export type Tx = chainAdapters.Transaction<ChainTypes> & { accountType?: UtxoAccountType }

export type TxFilter = {
  accountType?: UtxoAccountType
  caip19?: CAIP19
  caip2?: CAIP2
  txid?: TxId
}

export type TxHistoryById = {
  [k: TxId]: Tx
}

/* this is a one to many relationship of asset id to tx id, built up as
 * tx's come into the store over websockets
 *
 * e.g. an account with a single trade of FOX to USDC will produce the following
 * three related assets
 *
 * {
 *   foxCAIP19: [txid] // sell asset
 *   usdcCAIP19: [txid] // buy asset
 *   ethCAIP19: [txid] // fee asset
 * }
 *
 * where txid is the same txid related to all the above assets, as the
 * sell asset, buy asset, and fee asset respectively
 *
 * this allows us to O(1) select all related transactions to a given asset
 */

export type TxIdByAssetId = {
  [k: CAIP19]: TxId[]
}

export type TxIdByAccountId = {
  [k: AccountSpecifier]: TxId[]
}

// before the wallet is connected, we're idle
// when we subscribe to the history, we're loading
// after logic managing a delay after no new tx's in TransactionsProvider, we're loaded
export type TxHistoryStatus = 'idle' | 'loading' | 'loaded'

type RebaseId = string
type RebaseById = {
  [k: RebaseId]: RebaseHistory
}

type RebaseByAssetId = {
  [k: CAIP19]: RebaseId[]
}

type RebaseByAccountId = {
  [k: AccountSpecifier]: RebaseId[]
}

export type TxsState = {
  byId: TxHistoryById
  byAssetId: TxIdByAssetId
  byAccountId: TxIdByAccountId
  ids: TxId[]
  status: TxHistoryStatus
}

export type RebasesState = {
  byAssetId: RebaseByAssetId
  byAccountId: RebaseByAccountId
  ids: RebaseId[]
  byId: RebaseById
}

export type TxHistory = {
  txs: TxsState
  rebases: RebasesState
}

export type TxMessage = { payload: { message: Tx; accountSpecifier: string } }
export type TxsMessage = {
  payload: { txs: chainAdapters.Transaction<ChainTypes>[]; accountSpecifier: string }
}

// https://redux.js.org/usage/structuring-reducers/normalizing-state-shape#designing-a-normalized-state
const initialState: TxHistory = {
  txs: {
    byId: {},
    ids: [], // sorted, newest first
    byAssetId: {},
    byAccountId: {},
    status: 'idle'
  },
  rebases: {
    byAssetId: {},
    byAccountId: {},
    ids: [],
    byId: {}
  }
}

/**
 * Manage state of the txHistory slice
 *
 * If transaction already exists, update the value, otherwise add the new transaction
 */

/**
 * now we support accounts, we have a new problem
 * the same tx id can have multiple representations, depending on the
 * account's persective, especially utxos.
 *
 * i.e. a bitcoin send will have a send component, and a receive component for
 * the change, to a new address, but the same tx id.
 * this means we can't uniquely index tx's simply by their id.
 *
 * we'll probably need to go back to some composite index that can be built from
 * the txid and address, or account id, that can be deterministically generated,
 * from the tx data and the account id - note, not the address.
 *
 * the correct solution is to not rely on the parsed representation of the tx
 * as a "send" or "receive" from chain adapters, just index the tx related to the
 * asset or account, and parse the tx closer to the view layer.
 */
export const makeUniqueTxId = (tx: Tx, accountId: AccountSpecifier): string =>
  `${accountId}-${tx.txid}-${tx.address}`

const updateOrInsertTx = (txHistory: TxHistory, tx: Tx, accountSpecifier: AccountSpecifier) => {
  const { txs } = txHistory
  const txid = makeUniqueTxId(tx, accountSpecifier)

  const isNew = !txs.byId[txid]

  // update or insert tx
  txs.byId[txid] = tx

  // add id to ordered set for new tx
  if (isNew) {
    const orderedTxs = orderBy(txs.byId, 'blockTime', ['desc'])
    const index = orderedTxs.findIndex(tx => makeUniqueTxId(tx, accountSpecifier) === txid)
    txs.ids.splice(index, 0, txid)
  }

  // for a given tx, find all the related assetIds, and keep an index of
  // txids related to each asset id
  getRelatedAssetIds(tx).forEach(relatedAssetId => {
    txs.byAssetId[relatedAssetId] = addToIndex(
      txs.ids,
      txs.byAssetId[relatedAssetId],
      makeUniqueTxId(tx, accountSpecifier)
    )
  })

  // index the tx by the account that it belongs to
  txs.byAccountId[accountSpecifier] = addToIndex(
    txs.ids,
    txs.byAccountId[accountSpecifier],
    makeUniqueTxId(tx, accountSpecifier)
  )

  // ^^^ redux toolkit uses the immer lib, which uses proxies under the hood
  // this looks like it's not doing anything, but changes written to the proxy
  // get applied to state when it goes out of scope
}

type UpdateOrInsertRebase = (txState: TxHistory, data: RebaseHistoryPayload['payload']) => void

const updateOrInsertRebase: UpdateOrInsertRebase = (txState, payload) => {
  const { accountId, assetId } = payload
  const { rebases } = txState
  payload.data.forEach(rebase => {
    const rebaseId = makeRebaseId({ accountId, assetId, rebase })
    const isNew = !txState.rebases.byId[rebaseId]

    rebases.byId[rebaseId] = rebase

    if (isNew) {
      const orderedRebases = orderBy(rebases.byId, 'blockTime', ['desc'])
      const index = orderedRebases.findIndex(
        rebase => makeRebaseId({ accountId, assetId, rebase }) === rebaseId
      )
      rebases.ids.splice(index, 0, rebaseId)
    }

    rebases.byAssetId[assetId] = addToIndex(
      rebases.ids,
      rebases.byAssetId[assetId],
      makeRebaseId({ accountId, assetId, rebase })
    )

    // index the tx by the account that it belongs to
    rebases.byAccountId[accountId] = addToIndex(
      rebases.ids,
      rebases.byAccountId[accountId],
      makeRebaseId({ accountId, assetId, rebase })
    )
  })

  // ^^^ redux toolkit uses the immer lib, which uses proxies under the hood
  // this looks like it's not doing anything, but changes written to the proxy
  // get applied to state when it goes out of scope
}

type MakeRebaseIdArgs = {
  accountId: AccountSpecifier
  assetId: CAIP19
  rebase: RebaseHistory
}

type MakeRebaseId = (args: MakeRebaseIdArgs) => string

const makeRebaseId: MakeRebaseId = ({ accountId, assetId, rebase }) =>
  `${accountId}-${assetId}-${rebase.blockTime}`

type TxHistoryStatusPayload = { payload: TxHistoryStatus }
type RebaseHistoryPayload = {
  payload: {
    accountId: AccountSpecifier
    assetId: CAIP19
    data: RebaseHistory[]
  }
}

export const txHistory = createSlice({
  name: 'txHistory',
  initialState,
  reducers: {
    clear: () => initialState,
    setStatus: (state, { payload }: TxHistoryStatusPayload) => {
      state.txs.status = payload
    },
    onMessage: (txState, { payload }: TxMessage) =>
      updateOrInsertTx(txState, payload.message, payload.accountSpecifier),
    upsertTxs: (txState, { payload }: TxsMessage) => {
      for (const tx of payload.txs) {
        updateOrInsertTx(txState, tx, payload.accountSpecifier)
      }
    },
    upsertRebaseHistory: (txState, { payload }: RebaseHistoryPayload) =>
      updateOrInsertRebase(txState, payload)
  }
})

type AllTxHistoryArgs = { accountSpecifierMap: AccountSpecifierMap }

type RebaseTxHistoryArgs = {
  accountSpecifierMap: AccountSpecifierMap
  portfolioAssetIds: CAIP19[]
}

export const txHistoryApi = createApi({
  reducerPath: 'txHistoryApi',
  // not actually used, only used to satisfy createApi, we use a custom queryFn
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  // refetch if network connection is dropped, useful for mobile
  refetchOnReconnect: true,
  endpoints: build => ({
    getFoxyRebaseHistoryByAccountId: build.query<RebaseHistory[], RebaseTxHistoryArgs>({
      queryFn: async ({ accountSpecifierMap, portfolioAssetIds }, { dispatch }) => {
        // only fetch with foxy flag on
        if (!getConfig().REACT_APP_FEATURE_FOXY_INVESTOR) return { data: [] }

        // foxy contract address, note not caip19s
        const foxyTokenContractAddressWithBalances = foxyAddresses.reduce<string[]>(
          (acc, { foxy }) => {
            const contractAddress = foxy.toLowerCase()
            portfolioAssetIds.some(id => id.includes(contractAddress)) && acc.push(contractAddress)
            return acc
          },
          []
        )

        // don't do anything below if we don't hold a version of foxy
        if (!foxyTokenContractAddressWithBalances.length) return { data: [] }

        // we load rebase history on app load, but pass in all the specifiers
        const chain = ChainTypes.Ethereum
        const network = NetworkTypes.MAINNET
        // foxy is only on eth mainnet
        const chainId = caip2.toCAIP2({ chain, network })
        const entries = Object.entries(accountSpecifierMap)[0]
        const [accountChainId, userAddress] = entries

        const accountSpecifier = caip10.toCAIP10({ caip2: chainId, account: userAddress })
        // [] is a valid return type and won't upsert anything
        if (chainId !== accountChainId) return { data: [] }

        // setup chain adapters
        const adapters = getChainAdapters()
        if (!adapters.getSupportedChains().includes(ChainTypes.Ethereum)) {
          const data = `getFoxyRebaseHistoryByAccountId: ChainAdapterManager does not support ${ChainTypes.Ethereum}`
          const status = 400
          const error = { data, status }
          return { error }
        }

        // setup foxy api
        const adapter = await adapters.byChainId(chainId)
        const providerUrl = getConfig().REACT_APP_ETHEREUM_NODE_URL
        const foxyArgs = { adapter, foxyAddresses, providerUrl }
        const foxyApi = new FoxyApi(foxyArgs)

        foxyTokenContractAddressWithBalances.forEach(async tokenContractAddress => {
          const assetReference = tokenContractAddress
          const assetNamespace = AssetNamespace.ERC20
          const assetId = caip19.toCAIP19({ chain, network, assetNamespace, assetReference })
          const rebaseHistoryArgs = { userAddress, tokenContractAddress }
          const data = await foxyApi.getRebaseHistory(rebaseHistoryArgs)
          const upsertPayload = { accountId: accountSpecifier, assetId, data }
          if (data.length) dispatch(txHistory.actions.upsertRebaseHistory(upsertPayload))
        })

        // we don't really care about the caching of this, we're dispatching
        // into another part of the portfolio above, we kind of abuse RTK query,
        // and we're always force refetching these anyway
        return { data: [] }
      }
    }),
    getAllTxHistory: build.query<chainAdapters.Transaction<ChainTypes>[], AllTxHistoryArgs>({
      queryFn: async ({ accountSpecifierMap }, { dispatch }) => {
        if (isEmpty(accountSpecifierMap)) {
          const data = 'getAllTxHistory: No account specifier given to get all tx history'
          const error = { data, status: 400 }
          return { error }
        }
        const [CAIP2, pubkey] = Object.entries(accountSpecifierMap)[0] as [CAIP2, string]
        const accountSpecifier = `${CAIP2}:${pubkey}`
        try {
          let txs: chainAdapters.Transaction<ChainTypes>[] = []
          const chainAdapters = getChainAdapters()
          const { chain } = caip2.fromCAIP2(CAIP2)
          const adapter = chainAdapters.byChain(chain)
          let currentCursor: string = ''
          const pageSize = 100
          do {
            const { cursor: _cursor, transactions } = await adapter.getTxHistory({
              cursor: currentCursor,
              pubkey,
              pageSize
            })
            currentCursor = _cursor
            txs = [...txs, ...transactions]
          } while (currentCursor)
          dispatch(txHistory.actions.upsertTxs({ txs, accountSpecifier }))
          return { data: txs }
        } catch (err) {
          return {
            error: {
              data: `getAllTxHistory: An error occurred fetching all tx history for accountSpecifier: ${accountSpecifier}`,
              status: 500
            }
          }
        }
      }
    })
  })
})

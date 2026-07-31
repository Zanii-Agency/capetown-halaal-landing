import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Booth, BOOTHS } from './booth-data'

export interface User {
  id: string
  email: string
  name: string
  company: string
  phone: string
}

interface BoothStore {
  // User state
  user: User | null
  isAuthenticated: boolean

  // Booth state
  booths: Booth[]
  selectedBooth: Booth | null
  hoveredBooth: Booth | null
  cart: Booth[]

  // Filters
  filters: {
    size: string[]
    zone: string[]
    priceRange: [number, number]
    showAvailableOnly: boolean
  }

  // View state
  viewMode: '3d' | '2d'

  // User actions
  login: (user: User) => void
  logout: () => void
  register: (user: User) => void

  // Booth actions
  selectBooth: (booth: Booth | null) => void
  hoverBooth: (booth: Booth | null) => void
  addToCart: (booth: Booth) => void
  removeFromCart: (boothId: string) => void
  clearCart: () => void
  reserveBooth: (boothId: string) => void

  // Filter actions
  setFilters: (filters: Partial<BoothStore['filters']>) => void
  resetFilters: () => void

  // View actions
  setViewMode: (mode: '3d' | '2d') => void

  // Computed
  getFilteredBooths: () => Booth[]
  getCartTotal: () => number
}

const defaultFilters = {
  size: [],
  zone: [],
  priceRange: [1600, 8000] as [number, number],
  showAvailableOnly: true
}

export const useBoothStore = create<BoothStore>()(
  persist(
    (set, get) => ({
      // Initial state
      user: null,
      isAuthenticated: false,
      booths: BOOTHS,
      selectedBooth: null,
      hoveredBooth: null,
      cart: [],
      filters: defaultFilters,
      viewMode: '3d',

      // User actions
      login: (user) => set({ user, isAuthenticated: true }),
      logout: () => set({ user: null, isAuthenticated: false, cart: [] }),
      register: (user) => set({ user, isAuthenticated: true }),

      // Booth actions
      selectBooth: (booth) => set({ selectedBooth: booth }),
      hoverBooth: (booth) => set({ hoveredBooth: booth }),

      addToCart: (booth) => {
        const { cart, booths } = get()
        if (cart.find(b => b.id === booth.id)) return
        if (booth.status !== 'available') return

        // Update booth status in the booths array
        const updatedBooths = booths.map(b =>
          b.id === booth.id ? { ...b, status: 'reserved' as const } : b
        )

        set({
          cart: [...cart, booth],
          booths: updatedBooths
        })
      },

      removeFromCart: (boothId) => {
        const { cart, booths } = get()
        const updatedBooths = booths.map(b =>
          b.id === boothId ? { ...b, status: 'available' as const } : b
        )
        set({
          cart: cart.filter(b => b.id !== boothId),
          booths: updatedBooths
        })
      },

      clearCart: () => {
        const { cart, booths } = get()
        const cartIds = cart.map(b => b.id)
        const updatedBooths = booths.map(b =>
          cartIds.includes(b.id) ? { ...b, status: 'available' as const } : b
        )
        set({ cart: [], booths: updatedBooths })
      },

      reserveBooth: (boothId) => {
        const { booths } = get()
        const updatedBooths = booths.map(b =>
          b.id === boothId ? { ...b, status: 'reserved' as const } : b
        )
        set({ booths: updatedBooths })
      },

      // Filter actions
      setFilters: (newFilters) => {
        const { filters } = get()
        set({ filters: { ...filters, ...newFilters } })
      },

      resetFilters: () => set({ filters: defaultFilters }),

      // View actions
      setViewMode: (mode) => set({ viewMode: mode }),

      // Computed
      getFilteredBooths: () => {
        const { booths, filters } = get()
        return booths.filter(booth => {
          // Available only filter
          if (filters.showAvailableOnly && booth.status !== 'available') {
            return false
          }

          // Size filter
          if (filters.size.length > 0 && !filters.size.includes(booth.size)) {
            return false
          }

          // Zone filter
          if (filters.zone.length > 0 && !filters.zone.includes(booth.zone)) {
            return false
          }

          // Price range filter
          if (booth.price < filters.priceRange[0] || booth.price > filters.priceRange[1]) {
            return false
          }

          return true
        })
      },

      getCartTotal: () => {
        const { cart } = get()
        return cart.reduce((sum, booth) => sum + booth.price, 0)
      }
    }),
    {
      name: 'capetown-halaal-booth-store',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        cart: state.cart
      })
    }
  )
)

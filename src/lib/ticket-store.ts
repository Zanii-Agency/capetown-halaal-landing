import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface TicketType {
  id: string
  name: string
  date: string
  dayLabel: string
  dayNumber: number
  price: number
  description: string
}

export interface CartItem {
  ticket: TicketType
  quantity: number
}

export interface TicketBuyer {
  id?: string
  email: string
  name: string
  phone: string
}

interface TicketStore {
  // Ticket types
  tickets: TicketType[]

  // Cart
  cart: CartItem[]

  // Buyer
  buyer: TicketBuyer | null
  isLoggedIn: boolean

  // Actions
  addTicket: (ticketId: string) => void
  removeTicket: (ticketId: string) => void
  setQuantity: (ticketId: string, qty: number) => void
  clearCart: () => void
  getCartTotal: () => number
  getCartCount: () => number

  // Buyer actions
  setBuyer: (buyer: TicketBuyer) => void
  logout: () => void
}

const TICKET_TYPES: TicketType[] = [
  {
    id: 'friday-entry',
    name: 'Entry Ticket, Friday 11th December, Young at Heart Festival 2026',
    date: 'Friday, 11 December 2026',
    dayLabel: 'DAY 1',
    dayNumber: 1,
    price: 40,
    description: 'General entry for Friday',
  },
  {
    id: 'saturday-entry',
    name: 'Entry Ticket, Saturday 12th December, Young at Heart Festival 2026',
    date: 'Saturday, 12 December 2026',
    dayLabel: 'DAY 2',
    dayNumber: 2,
    price: 40,
    description: 'General entry for Saturday',
  },
  {
    id: 'sunday-entry',
    name: 'Entry Ticket, Sunday 13th December, Young at Heart Festival 2026',
    date: 'Sunday, 13 December 2026',
    dayLabel: 'DAY 3',
    dayNumber: 3,
    price: 40,
    description: 'General entry for Sunday',
  },
  {
    id: 'weekend-pass',
    name: 'Weekend Pass, All 3 Days, Young at Heart Festival 2026',
    date: '11–13 December 2026',
    dayLabel: 'ALL 3 DAYS',
    dayNumber: 0,
    price: 100,
    description: 'Entry for all three days (save R20)',
  },
]

export const useTicketStore = create<TicketStore>()(
  persist(
    (set, get) => ({
      tickets: TICKET_TYPES,
      cart: [],
      buyer: null,
      isLoggedIn: false,

      addTicket: (ticketId) => {
        const { cart, tickets } = get()
        const existing = cart.find(item => item.ticket.id === ticketId)
        if (existing) {
          set({
            cart: cart.map(item =>
              item.ticket.id === ticketId
                ? { ...item, quantity: item.quantity + 1 }
                : item
            ),
          })
        } else {
          const ticket = tickets.find(t => t.id === ticketId)
          if (ticket) {
            set({ cart: [...cart, { ticket, quantity: 1 }] })
          }
        }
      },

      removeTicket: (ticketId) => {
        const { cart } = get()
        const existing = cart.find(item => item.ticket.id === ticketId)
        if (existing && existing.quantity > 1) {
          set({
            cart: cart.map(item =>
              item.ticket.id === ticketId
                ? { ...item, quantity: item.quantity - 1 }
                : item
            ),
          })
        } else {
          set({ cart: cart.filter(item => item.ticket.id !== ticketId) })
        }
      },

      setQuantity: (ticketId, qty) => {
        const { cart, tickets } = get()
        if (qty <= 0) {
          set({ cart: cart.filter(item => item.ticket.id !== ticketId) })
          return
        }
        const existing = cart.find(item => item.ticket.id === ticketId)
        if (existing) {
          set({
            cart: cart.map(item =>
              item.ticket.id === ticketId
                ? { ...item, quantity: qty }
                : item
            ),
          })
        } else {
          const ticket = tickets.find(t => t.id === ticketId)
          if (ticket) {
            set({ cart: [...cart, { ticket, quantity: qty }] })
          }
        }
      },

      clearCart: () => set({ cart: [] }),

      getCartTotal: () => {
        const { cart } = get()
        return cart.reduce((sum, item) => sum + item.ticket.price * item.quantity, 0)
      },

      getCartCount: () => {
        const { cart } = get()
        return cart.reduce((sum, item) => sum + item.quantity, 0)
      },

      setBuyer: (buyer) => set({ buyer, isLoggedIn: true }),
      logout: () => set({ buyer: null, isLoggedIn: false }),
    }),
    {
      name: 'yah-ticket-store',
      partialize: (state) => ({
        cart: state.cart,
        buyer: state.buyer,
        isLoggedIn: state.isLoggedIn,
      }),
    }
  )
)

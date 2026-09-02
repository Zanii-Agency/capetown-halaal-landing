'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useBoothStore } from '@/lib/store'
import { formatPrice, BOOTH_TIERS } from '@/lib/booth-data'
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ShoppingCart, Trash2, CreditCard, X, LogIn, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { fireSuccessConfetti } from '@/lib/confetti'

export function Cart() {
  const { cart, removeFromCart, clearCart, getCartTotal, isAuthenticated } = useBoothStore()

  const total = getCartTotal()
  const vat = total * 0.15
  const grandTotal = total + vat

  if (cart.length === 0) {
    return (
      <Card className="bg-gray-900/50 border-white/10">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <ShoppingCart className="w-12 h-12 text-gray-600 mb-4" />
          <p className="text-gray-500 text-center">Your cart is empty</p>
          <p className="text-gray-600 text-sm text-center mt-1">
            Select booths from the floor plan to add them
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-gray-900/50 border-white/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <ShoppingCart className="w-4 h-4" />
            Cart ({cart.length})
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearCart}
            className="h-8 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Clear
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <ScrollArea className="max-h-[300px]">
          <AnimatePresence>
            {cart.map((booth) => {
              const tier = BOOTH_TIERS[booth.size]
              return (
                <motion.div
                  key={booth.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-3"
                >
                  <div className="flex items-center justify-between bg-white/5 rounded-lg p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">
                          Booth {booth.row}{booth.column}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {tier.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {booth.dimensions.width}m x {booth.dimensions.depth}m • {booth.sqm}m²
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#cd2653]">
                        {formatPrice(booth.price)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFromCart(booth.id)}
                        className="h-8 w-8 text-gray-500 hover:text-red-400"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </ScrollArea>

        <Separator className="bg-white/10" />

        {/* Summary */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Subtotal</span>
            <span>{formatPrice(total)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">VAT (15%)</span>
            <span>{formatPrice(vat)}</span>
          </div>
          <Separator className="bg-white/10" />
          <div className="flex justify-between text-lg font-bold">
            <span>Total</span>
            <span className="text-[#cd2653]">{formatPrice(grandTotal)}</span>
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex-col gap-3">
        {isAuthenticated ? (
          <Link href="/checkout" className="w-full" onClick={() => fireSuccessConfetti()}>
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button className="w-full bg-gradient-to-r from-[#cd2653] to-[#bf3026] hover:from-[#bf3026] hover:to-[#a82820] shadow-lg shadow-[#cd2653]/25 h-12 text-base font-semibold">
                <CreditCard className="w-5 h-5 mr-2" />
                Proceed to Checkout
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </motion.div>
          </Link>
        ) : (
          <Link href="/login" className="w-full">
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button className="w-full bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 shadow-lg shadow-blue-500/25 h-12 text-base font-semibold">
                <LogIn className="w-5 h-5 mr-2" />
                Login to Reserve
              </Button>
            </motion.div>
          </Link>
        )}
        <p className="text-[10px] text-gray-500 text-center">
          Booths are held for 15 minutes during checkout
        </p>
      </CardFooter>
    </Card>
  )
}

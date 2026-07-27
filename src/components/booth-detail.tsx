'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useBoothStore } from '@/lib/store'
import { BOOTH_TIERS, formatPrice } from '@/lib/booth-data'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { X, ShoppingCart, MapPin, Ruler, Zap, Check, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fireSmallConfetti } from '@/lib/confetti'

export function BoothDetail() {
  const { selectedBooth, selectBooth, cart, addToCart, removeFromCart } = useBoothStore()

  if (!selectedBooth) {
    return (
      <Card className="bg-gray-900/50 border-white/10 h-full">
        <CardContent className="flex items-center justify-center h-full min-h-[300px]">
          <div className="text-center text-gray-500">
            <MapPin className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Select a booth to view details</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const tier = BOOTH_TIERS[selectedBooth.size]
  const isInCart = cart.some(b => b.id === selectedBooth.id)
  const isAvailable = selectedBooth.status === 'available'

  const statusConfig = {
    available: { color: 'text-[#cd2653] bg-[#cd2653]/20 border-[#cd2653]/30', label: 'Available' },
    reserved: { color: 'text-amber-400 bg-amber-500/20 border-amber-500/30', label: 'Reserved' },
    sold: { color: 'text-red-400 bg-red-500/20 border-red-500/30', label: 'Sold' }
  }

  const zoneConfig = {
    standard: { color: 'bg-blue-500', label: 'Standard Zone' },
    premium: { color: 'bg-purple-500', label: 'Premium Zone' },
    prime: { color: 'bg-red-500', label: 'Prime Location' }
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={selectedBooth.id}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.2 }}
      >
        <Card className="bg-gray-900/50 border-white/10">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-xl font-bold">
                  Booth {selectedBooth.row}{selectedBooth.column}
                </CardTitle>
                <p className="text-sm text-gray-400 mt-1">{tier.label}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => selectBooth(null)}
                className="h-8 w-8"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Status and Zone badges */}
            <div className="flex flex-wrap gap-2">
              <Badge className={cn('border', statusConfig[selectedBooth.status].color)}>
                {statusConfig[selectedBooth.status].label}
              </Badge>
              <Badge variant="outline" className="gap-1">
                <span className={cn('w-2 h-2 rounded-full', zoneConfig[selectedBooth.zone].color)} />
                {zoneConfig[selectedBooth.zone].label}
              </Badge>
            </div>

            <Separator className="bg-white/10" />

            {/* Price */}
            <div className="flex items-baseline justify-between">
              <span className="text-gray-400">Price</span>
              <span className="text-3xl font-bold text-white">{formatPrice(selectedBooth.price)}</span>
            </div>

            {/* Dimensions */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400 flex items-center gap-2">
                <Ruler className="w-4 h-4" />
                Dimensions
              </span>
              <span className="text-white">
                {selectedBooth.dimensions.width}m x {selectedBooth.dimensions.depth}m ({selectedBooth.sqm}m²)
              </span>
            </div>

            <Separator className="bg-white/10" />

            {/* Features */}
            <div className="space-y-3">
              <span className="text-sm text-gray-400 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Included Features
              </span>
              <div className="grid grid-cols-1 gap-2">
                {selectedBooth.features.map((feature, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-[#cd2653]" />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            <Separator className="bg-white/10" />

            {/* Actions */}
            {isAvailable ? (
              isInCart ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[#cd2653] text-sm">
                    <Check className="w-4 h-4" />
                    Added to cart
                  </div>
                  <Button
                    variant="outline"
                    className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10"
                    onClick={() => removeFromCart(selectedBooth.id)}
                  >
                    Remove from Cart
                  </Button>
                </div>
              ) : (
                <motion.div whileTap={{ scale: 0.95 }}>
                <Button
                  className="w-full bg-gradient-to-r from-[#cd2653] to-[#bf3026] hover:from-[#bf3026] hover:to-[#a82820] shadow-lg shadow-[#cd2653]/25"
                  onClick={(e) => {
                    addToCart(selectedBooth)
                    fireSmallConfetti(e.clientX, e.clientY)
                  }}
                >
                  <ShoppingCart className="w-4 h-4 mr-2" />
                  Add to Cart
                </Button>
              </motion.div>
              )
            ) : (
              <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-500/10 p-3 rounded-lg">
                <AlertCircle className="w-4 h-4" />
                This booth is no longer available
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </AnimatePresence>
  )
}

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-white/5 text-neutral-300',
        secondary: 'border-white/5 bg-white/[0.02] text-neutral-400',
        destructive: 'border-red-500/20 bg-red-500/10 text-red-400',
        outline: 'border-white/10 text-neutral-400',
        success: 'border-green-500/20 bg-green-500/10 text-green-400',
        warning: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
        info: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

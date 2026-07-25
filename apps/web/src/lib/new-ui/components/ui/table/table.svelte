<script lang="ts">
  import type { HTMLTableAttributes } from 'svelte/elements';
  import { cn, type WithElementRef } from '#lib/new-ui/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLTableAttributes> = $props();
</script>

<!-- Keyboard users must be able to focus and scroll overflowing tables. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  data-slot="table-container"
  class="relative w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  role="region"
  aria-label="Scrollable table"
  tabindex="0"
>
  <table
    bind:this={ref}
    data-slot="table"
    class={cn('w-full caption-bottom text-sm', className)}
    {...restProps}
  >
    {@render children?.()}
  </table>
</div>

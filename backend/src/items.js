// Items. "weight" = labour-hours embodied in the item (its trade value; there is no money).
export const ITEMS = [
  { id: 'phone', name: 'Phone', weight: 6, emoji: '📱' },
  { id: 'laptop', name: 'Laptop', weight: 10, emoji: '💻' },
  { id: 'tablet', name: 'Tablet', weight: 5, emoji: '📲' },
  { id: 'tv', name: 'Television', weight: 10, emoji: '📺' },
  { id: 'camera', name: 'Camera', weight: 7, emoji: '📷' },
  { id: 'radio', name: 'Radio', weight: 4, emoji: '📻' },
  { id: 'headphones', name: 'Headphones', weight: 3, emoji: '🎧' },
  { id: 'bicycle', name: 'Bicycle', weight: 12, emoji: '🚲' },
  { id: 'skateboard', name: 'Skateboard', weight: 5, emoji: '🛹' },
  { id: 'guitar', name: 'Guitar', weight: 6, emoji: '🎸' },
  { id: 'telescope', name: 'Telescope', weight: 6, emoji: '🔭' },
  { id: 'chemistry_set', name: 'Chemistry set', weight: 3, emoji: '🧪' },
  { id: 'toolkit', name: 'Toolbox', weight: 5, emoji: '🧰' },
  { id: 'chair', name: 'Chair', weight: 4, emoji: '🪑' },
  { id: 'kettle', name: 'Kettle', weight: 3, emoji: '🫖' },
  { id: 'lamp', name: 'Lamp', weight: 2, emoji: '💡' },
  { id: 'blanket', name: 'Blanket', weight: 3, emoji: '🛏️' },
  { id: 'jacket', name: 'Jacket', weight: 4, emoji: '🧥' },
  { id: 'shoes', name: 'Shoes', weight: 3, emoji: '👟' },
  { id: 'watch', name: 'Watch', weight: 2, emoji: '⌚' },
  { id: 'boardgame', name: 'Board game', weight: 2, emoji: '🎲' },
  { id: 'vase', name: 'Vase', weight: 2, emoji: '🏺' },
  { id: 'book', name: 'Book', weight: 1, emoji: '📚' },
  { id: 'jojo', name: 'Yo-yo', weight: 1, emoji: '🪀' },
  { id: 'plant', name: 'Houseplant', weight: 1, emoji: '🪴' },
  { id: 'teddy', name: 'Teddy bear', weight: 1, emoji: '🧸' },
];
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const itemName = (id) => ITEM_BY_ID[id]?.name || id;
export const weightOf = (inv) => Object.entries(inv).reduce((s, [id, n]) => s + (ITEM_BY_ID[id]?.weight || 0) * n, 0);
export const countOf = (inv) => Object.values(inv).reduce((s, n) => s + n, 0);
export const fmtItems = (inv) =>
  Object.entries(inv).filter(([, n]) => n > 0).map(([id, n]) => `${n}× ${itemName(id)}`).join(', ') || 'nothing';
export function addItem(inv, id, n = 1) { inv[id] = (inv[id] || 0) + n; if (inv[id] <= 0) delete inv[id]; }

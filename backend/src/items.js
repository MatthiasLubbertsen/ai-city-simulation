// Spullen. "weight" = arbeidsuren die erin zitten (de ruilwaarde; geen geld).
export const ITEMS = [
  { id: 'phone', name: 'Telefoon', weight: 6, emoji: '📱' },
  { id: 'laptop', name: 'Laptop', weight: 10, emoji: '💻' },
  { id: 'tablet', name: 'Tablet', weight: 5, emoji: '📲' },
  { id: 'tv', name: 'Televisie', weight: 10, emoji: '📺' },
  { id: 'camera', name: 'Camera', weight: 7, emoji: '📷' },
  { id: 'radio', name: 'Radio', weight: 4, emoji: '📻' },
  { id: 'headphones', name: 'Koptelefoon', weight: 3, emoji: '🎧' },
  { id: 'bicycle', name: 'Fiets', weight: 12, emoji: '🚲' },
  { id: 'skateboard', name: 'Skateboard', weight: 5, emoji: '🛹' },
  { id: 'guitar', name: 'Gitaar', weight: 6, emoji: '🎸' },
  { id: 'telescope', name: 'Telescoop', weight: 6, emoji: '🔭' },
  { id: 'chemistry_set', name: 'Scheikundedoos', weight: 3, emoji: '🧪' },
  { id: 'toolkit', name: 'Gereedschapskist', weight: 5, emoji: '🧰' },
  { id: 'chair', name: 'Stoel', weight: 4, emoji: '🪑' },
  { id: 'kettle', name: 'Waterkoker', weight: 3, emoji: '🫖' },
  { id: 'lamp', name: 'Lamp', weight: 2, emoji: '💡' },
  { id: 'blanket', name: 'Deken', weight: 3, emoji: '🛏️' },
  { id: 'jacket', name: 'Jas', weight: 4, emoji: '🧥' },
  { id: 'shoes', name: 'Schoenen', weight: 3, emoji: '👟' },
  { id: 'watch', name: 'Horloge', weight: 2, emoji: '⌚' },
  { id: 'boardgame', name: 'Bordspel', weight: 2, emoji: '🎲' },
  { id: 'vase', name: 'Vaas', weight: 2, emoji: '🏺' },
  { id: 'book', name: 'Boek', weight: 1, emoji: '📚' },
  { id: 'jojo', name: 'Jojo', weight: 1, emoji: '🪀' },
  { id: 'plant', name: 'Kamerplant', weight: 1, emoji: '🪴' },
  { id: 'teddy', name: 'Knuffelbeer', weight: 1, emoji: '🧸' },
];
export const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const itemName = (id) => ITEM_BY_ID[id]?.name || id;
export const weightOf = (inv) => Object.entries(inv).reduce((s, [id, n]) => s + (ITEM_BY_ID[id]?.weight || 0) * n, 0);
export const countOf = (inv) => Object.values(inv).reduce((s, n) => s + n, 0);
export const fmtItems = (inv) =>
  Object.entries(inv).filter(([, n]) => n > 0).map(([id, n]) => `${n}× ${itemName(id)}`).join(', ') || 'niets';
export function addItem(inv, id, n = 1) { inv[id] = (inv[id] || 0) + n; if (inv[id] <= 0) delete inv[id]; }

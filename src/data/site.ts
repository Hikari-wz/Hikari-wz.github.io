export const site = {
  name: 'Hikari’s Space',
  description: '这里存放着我的代码、旅行、思考，以及生活中值得记录的一切。',
  github: 'https://github.com/Hikari-wz'
};

export const nav = [
  { label: '首页', href: '/' },
  { label: '记录', href: '/journal/' },
  { label: '学习', href: '/learn/' },
  { label: '实验', href: '/lab/' },
  { label: '工作台', href: '/desk/' },
  { label: '关于', href: '/about/' }
];

export const categories = { travel: '旅行', photography: '摄影', life: '生活' } as const;
export const topics = { cpp: 'C++ 与算法', math: '高等数学', languages: '英语与语言', computing: 'AI 与计算机' } as const;

export const spaces = [
  { name: '学习', en: 'Learn', note: '笔记、题解与知识整理', href: '/learn/', icon: 'book', color: 'sage' },
  { name: '旅行', en: 'Travel', note: '旅途见闻与沿路风景', href: '/journal/category/travel/', icon: 'mountain', color: 'blue' },
  { name: '创造', en: 'Lab', note: '独立项目与交互实验', href: '/lab/', icon: 'shapes', color: 'ochre' },
  { name: '生活', en: 'Life', note: '日常片段与随想', href: '/journal/category/life/', icon: 'coffee', color: 'rose' }
] as const;

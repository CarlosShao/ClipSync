/**
 * ClipSync 官网交互入口（无三方运行时依赖）
 *
 * 职责（对应 design/04-官网开发工程方案.md §2）：
 *  1. IntersectionObserver 入场动画 —— 逐字迁移自基线 design/mockups/website-v2-minimal.html 底部 <script>
 *  2. 导航滚动状态 —— 基线静态稿无此态，工程方案划入本文件（样式见 styles/sections/nav.css .nav--scrolled）
 *  3. 锚点平滑滚动 —— 现代浏览器由 base.css 的 html{scroll-behavior:smooth} 覆盖，
 *     此处仅为不支持该属性的旧浏览器提供 scrollIntoView 兜底
 *  4. FAQ 折叠 —— 基线使用原生 <details>/<summary>，无需 JS，保持基线行为不变
 */
import './styles/tokens.css';
import './styles/base.css';
// 引入顺序 = 基线 <style> 内的段落顺序，保证级联（cascade）与基线一致
import './styles/sections/nav.css';
import './styles/sections/hero.css';
import './styles/sections/sync.css';
import './styles/sections/encrypt.css';
import './styles/sections/ai.css';
import './styles/sections/pricing.css';
import './styles/sections/download.css';
import './styles/sections/faq.css';
import './styles/sections/cta-footer.css';

/** 入场动画：.reveal 进入视口后加 .in（基线 IO 参数 threshold:.12 原样保留） */
function initReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('.reveal');
  if (!('IntersectionObserver' in window)) {
    // 极旧浏览器兜底：不做动画，直接呈现全部内容
    targets.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries: IntersectionObserverEntry[]): void => {
      entries.forEach((entry): void => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  targets.forEach((el) => io.observe(el));
}

/** 导航滚动状态：离开页顶后给 nav 加 .nav--scrolled（见 nav.css，仅一层淡投影） */
function initNavScrollState(): void {
  const nav = document.querySelector('nav');
  if (!nav) return;
  const update = (): void => {
    nav.classList.toggle('nav--scrolled', window.scrollY > 4);
  };
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/** 锚点平滑滚动：仅对不支持 CSS scroll-behavior 的浏览器生效（现代浏览器走 base.css） */
function initSmoothAnchors(): void {
  if ('scrollBehavior' in document.documentElement.style) return;
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (ev: MouseEvent): void => {
      const href = a.getAttribute('href');
      if (!href || href === '#') return; // 页脚占位链接（href="#"）不做处理
      const target = document.querySelector(href);
      if (!target) return;
      ev.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function main(): void {
  initReveal();
  initNavScrollState();
  initSmoothAnchors();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

# AstroPaper 📄

![AstroPaper](public/default-og.jpg)
[![Figma](https://img.shields.io/badge/Figma-F24E1E?style=for-the-badge&logo=figma&logoColor=white)](https://www.figma.com/community/file/1356898632249991861)
![Typescript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![GitHub](https://img.shields.io/github/license/satnaing/astro-paper?color=%232F3741&style=for-the-badge)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-%23FE5196?logo=conventionalcommits&logoColor=white&style=for-the-badge)](https://conventionalcommits.org)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg?style=for-the-badge)](http://commitizen.github.io/cz-cli/)

AstroPaper 是一个极简、响应式、无障碍且对 SEO 友好的 Astro 博客主题。该主题是根据[我的个人博客](https://satnaing.dev/blog)设计并制作的。

阅读[博客文章](https://astro-paper.pages.dev/posts/)或查看 [README 文档部分](#-文档)以获取更多信息。

## 🔥 特性

- [x] 类型安全的 Markdown
- [x] 极速的性能表现
- [x] 无障碍设计（支持键盘/VoiceOver 导航）
- [x] 响应式布局（适配移动端至桌面端）
- [x] SEO 友好
- [x] 支持深色与浅色模式切换
- [x] 静态搜索（基于 [Pagefind](https://pagefind.app/)）
- [x] 草稿机制与分页
- [x] 自动生成 Sitemap 与 RSS Feed
- [x] 支持 MDX
- [x] 可折叠的文章目录
- [x] 遵循最佳开发实践
- [x] 高度可定制
- [x] 博客文章动态 OG 图片生成（详见[博客文章](https://astro-paper.pages.dev/posts/dynamic-og-image-generation-in-astropaper-blog-posts/)）
- [x] 原生支持多语言（i18n）

*注：我已经在 Mac 上的 **VoiceOver** 和 Android 上的 **TalkBack** 测试了 AstroPaper 的屏幕阅读器无障碍性。虽然无法测试市面上所有的屏幕阅读器，但 AstroPaper 的无障碍优化在其他平台上也应能正常工作。*

## ✅ Lighthouse 评分

<p align="center">
  <a href="https://pagespeed.web.dev/report?url=https%3A%2F%2Fastro-paper.pages.dev%2F&form_factor=desktop">
    <img width="710" alt="AstroPaper Lighthouse Score" src="AstroPaper-lighthouse-score.svg">
  </a>
</p>

## 🚀 项目结构

在 AstroPaper 项目中，您将看到以下文件夹和文件：

```bash
/
├── public/
│   ├── pagefind/          # 构建时自动生成
│   ├── favicon.svg
│   └── default-og.jpg
├── src/
│   ├── assets/
│   │   ├── icons/
│   │   └── images/
│   ├── components/
│   ├── content/
│   │   ├── pages/
│   │   │   └── about.md
│   │   └── posts/
│   │       └── some-blog-posts.md
│   ├── i18n/
│   ├── layouts/
│   ├── pages/
│   ├── scripts/
│   ├── styles/
│   ├── types/
│   ├── utils/
│   ├── config.ts
│   └── content.config.ts
├── astro-paper.config.ts  # 用户自定义配置文件
├── astro.config.ts
```

所有博客文章都存放在 `src/content/posts/` 目录中。您可以将文章整理到子目录中，子目录的名称将成为文章 URL 的一部分。

## 📖 文档

文档有两种阅读方式：*markdown 源码* 和 *博客文章*。

- 主题配置 - [markdown 源码](src/content/posts/how-to-configure-astropaper-theme.md) | [网页文章](https://astro-paper.pages.dev/posts/how-to-configure-astropaper-theme/)
- 添加文章 - [markdown 源码](src/content/posts/adding-new-post.md) | [网页文章](https://astro-paper.pages.dev/posts/adding-new-posts-in-astropaper-theme/)
- 自定义配色方案 - [markdown 源码](src/content/posts/customizing-astropaper-theme-color-schemes.md) | [网页文章](https://astro-paper.pages.dev/posts/customizing-astropaper-theme-color-schemes/)
- 预设配色方案 - [markdown 源码](src/content/posts/predefined-color-schemes.md) | [网页文章](https://astro-paper.pages.dev/posts/predefined-color-schemes/)

## 💻 技术栈

**核心框架** - [Astro](https://astro.build/)  
**类型检查** - [TypeScript](https://www.typescriptlang.org/)  
**样式** - [TailwindCSS](https://tailwindcss.com/)  
**UI/UX 设计** - [Figma 设计文件](https://www.figma.com/community/file/1356898632249991861)  
**静态搜索** - [Pagefind](https://pagefind.app/)  
**图标** - [Tabler Icons](https://tabler-icons.io/)  
**代码格式化** - [Prettier](https://prettier.io/)  
**部署平台** - [Cloudflare Pages](https://pages.cloudflare.com/) / [Vercel](https://vercel.com)  
**语法检查** - [ESLint](https://eslint.org)  
**动态 OG 图片** - [Satori](https://github.com/vercel/satori) + [Sharp](https://sharp.pixelplumbing.com/) + [Astro Fonts](https://docs.astro.build/en/guides/fonts/)

## 👨🏻‍💻 本地运行

您可以在所需的目录中运行以下命令在本地启动本项目：

```bash
# pnpm
pnpm create astro@latest --template satnaing/astro-paper

# npm
npm create astro@latest -- --template satnaing/astro-paper

# yarn
yarn create astro --template satnaing/astro-paper

# bun
bun create astro@latest -- --template satnaing/astro-paper
```

然后运行以下命令启动项目：

```bash
# 如果在前面的步骤中未安装依赖，请先安装：
pnpm install

# 启动本地开发服务器
pnpm dev
```

## Google 网站所有权验证（可选）

您可以通过设置 `astro-paper.config.ts` 中的 `site.googleVerification` 来添加您的 [Google 网站验证 HTML 标签](https://support.google.com/webmasters/answer/9008080#meta_tag_verification&zippy=%2Chtml-tag)：

```ts file="astro-paper.config.ts"
export default defineAstroPaperConfig({
  site: {
    // ...
    googleVerification: "您的 Google 验证码",
  },
  // ...
});
```

## 🧞 常用命令

所有命令均在项目的根目录下从终端运行：

| 命令 | 作用 |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` | 安装依赖包 |
| `pnpm dev` | 在 `localhost:4321` 启动本地开发服务器 |
| `pnpm build` | 类型检查，构建站点，执行 Pagefind 索引生成，并将其复制到 `public/pagefind/` |
| `pnpm preview` | 在部署之前，本地预览构建完成的站点 |
| `pnpm sync` | 为所有 Astro 模块生成 TypeScript 类型。 |
| `pnpm astro ...` | 运行 Astro 命令行指令，如 `astro add`, `astro check` |

## ✨ 反馈与建议

如果您有任何建议或反馈，可以通过[我的邮箱](mailto:satnaingdev+astropaper@gmail.com)与我取得联系。另外，如果您发现 bug 或希望请求新功能，欢迎随时开 Issue。

## 📜 开源协议

本项目基于 MIT 协议开源，版权所有 © 2026

---

由 [Sat Naing](https://satnaing.dev) 👨🏻‍💻 和 [贡献者们](https://github.com/satnaing/astro-paper/graphs/contributors) 用 🤍 制作。

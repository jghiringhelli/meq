import { test, expect } from '@playwright/test';

test.describe('Responsive layout', () => {
  test('Desktop (1200px): sidebar and board side-by-side', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('http://localhost:5199');
    
    // Click "New game"
    const newGameBtn = page.locator('button', { hasText: /New game/ }).first();
    await newGameBtn.click();
    
    // Choose heroes (click Heroes side)
    const heroBtn = page.locator('.side-btn').first();
    await heroBtn.click();
    
    // Click "Begin quest"
    const beginBtn = page.locator('button', { hasText: /Begin quest/ });
    await beginBtn.click({ timeout: 5000 });
    
    // Wait for play layout to appear
    await page.locator('.play-layout').waitFor({ timeout: 5000 });
    
    // Verify layout is horizontal (flexbox row) on desktop
    const playLayout = page.locator('.play-layout');
    const layout = await playLayout.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection || 'row'
      };
    });
    
    expect(layout.display).toBe('flex');
    expect(layout.flexDirection).toBe('row');
    
    // Verify board has reasonable width
    const board = page.locator('.board-wrap');
    const boardRect = await board.boundingBox();
    expect(boardRect?.width).toBeGreaterThan(500);
  });

  test('Mobile (390px): sidebar and board stack vertically', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5199');
    
    // Click "New game"
    const newGameBtn = page.locator('button', { hasText: /New game/ }).first();
    await newGameBtn.click();
    
    // Choose heroes (click Heroes side)
    const heroBtn = page.locator('.side-btn').first();
    await heroBtn.click();
    
    // Click "Begin quest"
    const beginBtn = page.locator('button', { hasText: /Begin quest/ });
    await beginBtn.click({ timeout: 5000 });
    
    // Wait for play layout to appear
    await page.locator('.play-layout').waitFor({ timeout: 5000 });
    
    // Verify layout is vertical (flexbox column) on mobile
    const playLayout = page.locator('.play-layout');
    const layout = await playLayout.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection || 'row'
      };
    });
    
    expect(layout.display).toBe('flex');
    expect(layout.flexDirection).toBe('column');
    
    // Verify board is visible and has reasonable height
    const board = page.locator('.board-wrap');
    const boardRect = await board.boundingBox();
    expect(boardRect?.height).toBeGreaterThan(250);
    
    // Verify sidebar is full width on mobile
    const side = page.locator('.side');
    const sideRect = await side.boundingBox();
    expect(sideRect?.width).toBeGreaterThan(300);
  });

  test('Tablet (600px): layout transitions to vertical', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('http://localhost:5199');
    
    // Click "New game"
    const newGameBtn = page.locator('button', { hasText: /New game/ }).first();
    await newGameBtn.click();
    
    // Choose heroes (click Heroes side)
    const heroBtn = page.locator('.side-btn').first();
    await heroBtn.click();
    
    // Click "Begin quest"
    const beginBtn = page.locator('button', { hasText: /Begin quest/ });
    await beginBtn.click({ timeout: 5000 });
    
    // Wait for play layout to appear
    await page.locator('.play-layout').waitFor({ timeout: 5000 });
    
    // Verify layout is vertical at 600px breakpoint
    const playLayout = page.locator('.play-layout');
    const layout = await playLayout.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection || 'row'
      };
    });
    
    expect(layout.flexDirection).toBe('column');
  });
});


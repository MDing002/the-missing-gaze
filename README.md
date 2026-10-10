# THE MISSING GAZE

A p5.js choreographic score for webcam, face tracking, and hand tracking.

The website displays a visual instruction first. The performer follows by covering or uncovering the corresponding eye. MediaPipe verifies the action, then the score advances to a new random instruction.

## Requirements

- Node.js 18 or newer
- A webcam
- Chrome, Edge, or Safari
- Internet access while running, because p5.js and MediaPipe Tasks are loaded from CDN URLs

## Run on macOS

1. Open Terminal.
2. Go to the project folder:

   ```bash
   cd path/to/project-folder
   ```

3. Install the npm project metadata:

   ```bash
   npm install
   ```

4. Start the local server:

   ```bash
   npm start
   ```

5. Open:

   ```text
   http://localhost:5174
   ```

6. Click **Enable camera** and allow camera access.

## Run on Windows

1. Open PowerShell or Command Prompt.
2. Go to the project folder:

   ```powershell
   cd path\to\project-folder
   ```

3. Install the npm project metadata:

   ```powershell
   npm install
   ```

4. Start the local server:

   ```powershell
   npm start
   ```

5. Open:

   ```text
   http://localhost:5174
   ```

6. Click **Enable camera** and allow camera access.

## Notes

- Do not open `dist/index.html` directly as a file. Use `http://localhost:5174` so the browser can grant webcam permission.
- If the webcam does not start, check browser camera permissions and close other apps that may be using the camera.
- The technical tracking panel is secondary; the main artwork is generated procedurally with p5.js.
- If port `5174` is already in use, stop the other local server first, then run `npm start` again.

## Publish With GitHub Pages

This project is ready to deploy as a static GitHub Pages site from the `dist` folder.

The included GitHub Actions workflow is:

```text
.github/workflows/pages.yml
```

It uploads the `dist` folder to GitHub Pages. The site uses relative local paths for `style.css` and `sketch.js`, and HTTPS CDN URLs for p5.js and MediaPipe.

### Before publishing

1. Create a GitHub repository.
2. Add this project folder to that repository.
3. Commit the files.
4. Push to the `main` branch.
5. In the GitHub repository, go to **Settings → Pages**.
6. Under **Build and deployment**, choose **GitHub Actions**.
7. Run the workflow, or push to `main` to trigger it.

After deployment, GitHub will show a public HTTPS URL similar to:

```text
https://your-username.github.io/your-repository-name/
```

Webcam access requires HTTPS, which GitHub Pages provides automatically.

Do not make the repository public until you are ready to share the work.

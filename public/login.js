const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginMessage = document.querySelector('#login-message');

function showLoginError(message) {
  loginMessage.textContent = message;
  loginMessage.classList.add('is-error');
  loginMessage.hidden = false;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = loginForm.elements.password.value;

  if (!password) {
    showLoginError('Vul je wachtwoord in.');
    return;
  }

  loginButton.disabled = true;
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (response.status === 204) {
      window.location.replace('/');
      return;
    }

    let message = 'Inloggen is mislukt.';
    try {
      const result = await response.json();
      message = result.error?.message || message;
    } catch {
      // De server gaf geen JSON terug; de algemene melding blijft staan.
    }
    showLoginError(message);
    loginForm.elements.password.select();
  } catch {
    showLoginError('Geen verbinding met de lokale server.');
  } finally {
    loginButton.disabled = false;
  }
});

loginForm.elements.password.focus();
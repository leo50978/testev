// ============= PAYMENT COMPONENT - PROCESSUS DE PAIEMENT =============
import {
  createOrderSecure,
  getPublicPaymentOptionsSecure,
} from './secure-functions.js';

const OCR_LANGUAGE = 'fra+eng';
let tesseractRuntimePromise = null;

async function loadTesseractRuntime() {
  if (typeof window !== 'undefined' && window.Tesseract && typeof window.Tesseract.recognize === 'function') {
    return window.Tesseract;
  }

  if (!tesseractRuntimePromise) {
    tesseractRuntimePromise = (async () => {
      const moduleUrls = [
        'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js',
        'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.esm.min.js',
      ];

      for (const url of moduleUrls) {
        try {
          const mod = await import(url);
          const maybeLib = (mod && mod.default && typeof mod.default.recognize === 'function')
            ? mod.default
            : mod;
          if (maybeLib && typeof maybeLib.recognize === 'function') {
            return maybeLib;
          }
        } catch (_) {
          // fallback sur autre source
        }
      }

      await new Promise((resolve, reject) => {
        const existing = document.getElementById('tesseract-runtime-script');
        if (existing) {
          if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
            resolve();
            return;
          }
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', () => reject(new Error('Impossible de charger Tesseract')), { once: true });
          return;
        }

        const script = document.createElement('script');
        script.id = 'tesseract-runtime-script';
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Impossible de charger Tesseract'));
        document.head.appendChild(script);
      });

      if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
        return window.Tesseract;
      }

      throw new Error('Tesseract indisponible');
    })().catch((error) => {
      tesseractRuntimePromise = null;
      throw error;
    });
  }

  return tesseractRuntimePromise;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function sanitizeAsset(value) {
  const out = String(value || '').trim();
  if (!out) return '';

  const baseValue = out.replace(/\\/g, '/').split(/[?#]/)[0];
  const fileName = baseValue.split('/').pop() || '';
  if (!/^[a-zA-Z0-9._-]+\.(png|jpe?g|gif|webp|svg)$/i.test(fileName)) {
    return '';
  }
  return fileName;
}

class PaymentModal {
  constructor(options = {}) {
    this.options = {
      amount: 0,
      client: null,
      cart: [],
      methodId: null,
      onClose: null,
      onSuccess: null,
      imageBasePath: './',
      delivery: null,
      ...options
    };
    
    this.uniqueId = 'payment_' + Math.random().toString(36).substr(2, 9);
    this.modal = null;
    this.methods = [];
    this.method = null;
    this.steps = [];
    this.currentStep = 0;
    this.clientData = this.options.client ? { ...this.options.client } : {};
    this.selectedMethod = null;
    this.settings = null;
    this.countdownInterval = null;
    this.timeLeft = 0;
    this.proofImageFile = null;
    this.extractedText = '';
    this.extractedTextStatus = 'pending';
    this.isSubmitted = false;
    this.isCompleted = false;
    
    this.init();
  }

  getDefaultSteps() {
    return [
      {
        type: 'custom',
        title: 'Vérification avant paiement',
        content: 'Vérifiez que votre compte de paiement sélectionné contient le montant du dépôt plus les taxes, puis continuez.',
        buttonText: 'Suivant'
      },
      {
        type: 'payment',
        title: 'Informations de paiement',
        instruction: 'Utilisez les données ci-dessous pour faire un dépôt ou transfert. Si vous utilisez le code QR, vous ne paierez pas de frais.',
        buttonText: 'Suivant'
      },
      {
        type: 'proof',
        title: 'Preuve de paiement',
        description: 'Ajoutez votre capture ou référence de transaction.',
        buttonText: 'Soumettre ma demande'
      },
      {
        type: 'confirmation',
        title: 'Confirmation',
        message: 'Votre demande est en cours de vérification. Le délai est de 12 heures.'
      }
    ];
  }

  getMethodSteps(method) {
    const steps = Array.isArray(method?.steps) ? method.steps.filter(Boolean) : [];
    return steps.length > 0 ? steps : this.getDefaultSteps();
  }
  
  async init() {
    await this.loadSettings();
    await this.loadPaymentMethods();
    this.render();
    this.attachEvents();
    this.animateIn();
    
    document.body.style.overflow = 'hidden';
  }
  
  async loadSettings() {
    try {
      const payload = await getPublicPaymentOptionsSecure({});
      this.settings = payload?.settings || {
        verificationHours: 12,
        expiredMessage: 'Le délai de vérification est dépassé. Contactez le support.'
      };
      this.methods = Array.isArray(payload?.methods)
        ? payload.methods
          .map((item) => {
            const data = { ...(item || {}) };
            data.steps = this.getMethodSteps(data);
            return data;
          })
          .filter((m) => m && m.isActive !== false)
        : [];
    } catch (error) {
      console.error('❌ Erreur chargement paramètres:', error);
      this.settings = { verificationHours: 12 };
      this.methods = [];
    }
  }
  
  async loadPaymentMethods() {
    if (!Array.isArray(this.methods)) {
      this.methods = [];
    }
    try {
      if (this.options.methodId) {
        this.selectedMethod = this.methods.find(m => m.id === this.options.methodId);
        if (this.selectedMethod) {
          this.steps = this.getMethodSteps(this.selectedMethod);
          this.currentStep = 1;
        }
      }
      
      if (this.methods.length === 1 && !this.selectedMethod) {
        this.selectedMethod = this.methods[0];
        this.steps = this.getMethodSteps(this.selectedMethod);
        this.currentStep = 1;
      }
    } catch (error) {
      console.error('❌ Erreur chargement méthodes:', error);
      this.methods = [];
    }
  }
  
  getImagePath(filename) {
    const safeFilename = sanitizeAsset(filename);
    if (!safeFilename) return '';
    if (safeFilename.startsWith('http')) return safeFilename;
    const cleanName = safeFilename.split('/').pop();
    return `${this.options.imageBasePath}${cleanName}`;
  }
  
  formatPrice(price) {
    return new Intl.NumberFormat('fr-FR', { 
      style: 'currency', 
      currency: 'HTG',
      minimumFractionDigits: 0
    }).format(price || 0);
  }
  
  render() {
    this.modal = document.createElement('div');
    this.modal.className = `payment-modal-${this.uniqueId}`;
    this.modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
      z-index: 1000000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    
    this.modal.innerHTML = `
      <div class="payment-container-${this.uniqueId} payment-theme-${this.uniqueId}" style="
        background: rgba(63, 71, 102, 0.58);
        border-radius: 1.5rem;
        width: 100%;
        max-width: 600px;
        max-height: 90vh;
        overflow-y: auto;
        border: 1px solid rgba(255,255,255,0.18);
        box-shadow: 14px 14px 34px rgba(17, 24, 39, 0.48), -10px -10px 24px rgba(113, 128, 168, 0.2);
        backdrop-filter: blur(14px);
        transform: scale(0.95);
        transition: transform 0.3s ease;
        position: relative;
      ">
        <!-- Header avec progression -->
        <div style="
          position: sticky;
          top: 0;
          background: rgba(63, 71, 102, 0.52);
          border-bottom: 1px solid rgba(255,255,255,0.14);
          padding: 1.5rem;
          z-index: 10;
          border-radius: 1.5rem 1.5rem 0 0;
        ">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <div style="display: flex; align-items: center; gap: 1rem;">
              ${this.currentStep > 0 ? `
                <button class="back-step payment-icon-btn" style="
                  background: none;
                  border: none;
                  font-size: 1.2rem;
                  cursor: pointer;
                  color: rgba(255,255,255,0.82);
                  padding: 0.5rem;
                  width: 40px;
                  height: 40px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  border-radius: 50%;
                  transition: all 0.2s;
                ">
                  <i class="fas fa-arrow-left"></i>
                </button>
              ` : ''}
              <h2 style="
                font-family: 'Cormorant Garamond', serif;
                font-size: 1.5rem;
                color: #ffffff;
                margin: 0;
              ">
                Paiement sécurisé
              </h2>
            </div>
            <button class="close-payment payment-icon-btn" style="
              background: none;
              border: none;
              font-size: 1.5rem;
              cursor: pointer;
              color: rgba(255,255,255,0.82);
              transition: all 0.2s;
              padding: 0.5rem;
              width: 40px;
              height: 40px;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 50%;
            ">
              <i class="fas fa-times"></i>
            </button>
          </div>
          
          ${this.renderProgressBar()}
        </div>
        
        <div style="padding: 1.5rem;">
          ${this.renderCurrentStep()}
        </div>
      </div>
      
      <style>
        .payment-container-${this.uniqueId} {
          animation: paymentSlideIn 0.3s ease forwards;
        }

        .payment-theme-${this.uniqueId} p,
        .payment-theme-${this.uniqueId} span,
        .payment-theme-${this.uniqueId} h1,
        .payment-theme-${this.uniqueId} h2,
        .payment-theme-${this.uniqueId} h3,
        .payment-theme-${this.uniqueId} h4,
        .payment-theme-${this.uniqueId} label {
          color: #ffffff !important;
        }

        .payment-theme-${this.uniqueId} .payment-icon-btn:hover {
          background: rgba(198, 167, 94, 0.1) !important;
          color: #C6A75E !important;
        }
        
        @keyframes paymentSlideIn {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        
        .payment-container-${this.uniqueId}::-webkit-scrollbar {
          width: 6px;
        }
        
        .payment-container-${this.uniqueId}::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.14);
          border-radius: 3px;
        }

        .payment-container-${this.uniqueId}::-webkit-scrollbar-thumb {
          background: rgba(245,124,0,0.85);
          border-radius: 3px;
        }
        
        .method-card {
          transition: all 0.25s ease;
          cursor: pointer;
          border: 1px solid rgba(255,255,255,0.2) !important;
          background: rgba(255,255,255,0.10) !important;
          backdrop-filter: blur(8px);
          box-shadow: 10px 10px 22px rgba(18,25,42,0.38), -8px -8px 18px rgba(121,135,173,0.18), inset 5px 5px 10px rgba(255,255,255,0.05), inset -5px -5px 10px rgba(8,13,24,0.18);
        }
        
        .method-card:hover {
          transform: translateY(-2px);
          background: rgba(255,255,255,0.14) !important;
          box-shadow: 12px 12px 24px rgba(16,22,38,0.42), -8px -8px 18px rgba(132,147,188,0.20), inset 5px 5px 10px rgba(255,255,255,0.06), inset -5px -5px 10px rgba(8,13,24,0.22);
        }
        
        .method-card.selected {
          border-color: #ffb26e !important;
          background: rgba(245,124,0,0.18) !important;
          box-shadow: 12px 12px 26px rgba(120,61,23,0.45), -8px -8px 18px rgba(255,174,98,0.14), inset 5px 5px 10px rgba(255,255,255,0.06), inset -5px -5px 10px rgba(8,13,24,0.22);
        }
        
        .countdown-timer {
          font-family: monospace;
          font-size: 1.5rem;
          font-weight: bold;
          color: #F57C00;
        }
        
        .form-group {
          margin-bottom: 1rem;
        }
        
        .form-group label {
          display: block;
          margin-bottom: 0.25rem;
          font-size: 0.9rem;
          color: rgba(255,255,255,0.82);
        }
        
        .form-group input,
        .form-group textarea,
        .form-group select {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid rgba(255,255,255,0.24);
          border-radius: 0.9rem;
          background: rgba(255,255,255,0.12);
          color: #ffffff;
          box-shadow: inset 6px 6px 12px rgba(19, 26, 43, 0.42), inset -6px -6px 12px rgba(120, 134, 172, 0.22);
          font-size: 0.95rem;
        }
        
        .form-group input:focus,
        .form-group textarea:focus,
        .form-group select:focus {
          outline: none;
          border-color: #F57C00;
        }
        
        .next-step-btn {
          width: 100%;
          background: #F57C00;
          color: #ffffff;
          border: 1px solid #ffb26e;
          padding: 1rem;
          border-radius: 0.9rem;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.3s;
          margin-top: 1.5rem;
          box-shadow: 8px 8px 18px rgba(17, 24, 39, 0.42), -6px -6px 14px rgba(123, 137, 180, 0.2);
        }

        .next-step-btn:hover {
          background: #ff8b1f;
          color: #ffffff;
        }
        
        .next-step-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .warning-message {
          background: rgba(255,255,255,0.12);
          border-left: 4px solid #F57C00;
          padding: 1rem;
          border-radius: 0.5rem;
          margin-bottom: 1.5rem;
          font-size: 0.9rem;
        }
        
        .loading-spinner {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 2px solid rgba(255,255,255,0.3);
          border-radius: 50%;
          border-top-color: white;
          animation: spin 0.8s linear infinite;
        }
        
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
      </style>
    `;
    
    document.body.appendChild(this.modal);
  }
  
  renderProgressBar() {
    const totalSteps = 1 + (this.steps?.length || 0);
    const currentStepDisplay = this.currentStep + 1;
    const progress = (currentStepDisplay / totalSteps) * 100;
    
    return `
      <div style="margin-top: 0.5rem;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
          <span style="font-size: 0.85rem; color: #8B7E6B;">Étape ${currentStepDisplay}/${totalSteps}</span>
          <span style="font-size: 0.85rem; color: #8B7E6B;">${Math.round(progress)}%</span>
        </div>
        <div style="
          width: 100%;
          height: 4px;
          background: rgba(198, 167, 94, 0.2);
          border-radius: 2px;
          overflow: hidden;
        ">
          <div style="
            width: ${progress}%;
            height: 100%;
            background: #C6A75E;
            transition: width 0.3s ease;
          "></div>
        </div>
      </div>
    `;
  }
  
  renderCurrentStep() {
    if (this.currentStep === 0) {
      return this.renderStep0();
    }
    
    if (!this.steps || this.steps.length === 0) {
      return this.renderNoSteps();
    }
    
    const stepIndex = this.currentStep - 1;
    const step = this.steps[stepIndex];
    
    if (!step) {
      return this.renderNoSteps();
    }
    
    switch(step.type) {
      case 'form':
        return this.renderFormStep(step);
      case 'payment':
        return this.renderPaymentStep(step);
      case 'proof':
        return this.renderProofStep(step);
      case 'confirmation':
        return this.renderConfirmationStep(step);
      default:
        return this.renderCustomStep(step);
    }
  }
  
  renderStep0() {
    if (this.methods.length === 0) {
      return `
        <div style="text-align: center; padding: 2rem;">
          <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: #B76E2E; margin-bottom: 1rem;"></i>
          <h3 style="font-size: 1.2rem; margin-bottom: 1rem;">Aucune méthode disponible</h3>
          <p style="color: #8B7E6B;">Veuillez réessayer plus tard.</p>
        </div>
      `;
    }
    
    return `
      <div>
        <h3 style="font-size: 1.3rem; margin-bottom: 1rem;">Choisissez votre méthode de paiement</h3>
        <p style="color: #8B7E6B; margin-bottom: 1.5rem;">Sélectionnez parmi nos options disponibles</p>
        
        <div id="methodsList" style="display: flex; flex-direction: column; gap: 1rem;">
          ${this.methods.map(method => this.renderMethodCard(method)).join('')}
        </div>
      </div>
    `;
  }
  
  renderMethodCard(method) {
    const isSelected = this.selectedMethod?.id === method.id;
    const safeMethodId = escapeAttr(method?.id || '');
    const safeMethodName = escapeHtml(method?.name || 'Méthode');
    const safeInstructions = escapeHtml(method?.instructions || '');
    const safeImagePath = escapeAttr(this.getImagePath(method?.image));
    
    return `
      <div class="method-card" data-method-id="${safeMethodId}" style="
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem;
        border: 1px solid ${isSelected ? '#ffb26e' : 'rgba(255,255,255,0.2)'};
        border-radius: 1rem;
        background: ${isSelected ? 'rgba(245,124,0,0.18)' : 'rgba(255,255,255,0.10)'};
        color: #ffffff;
        cursor: pointer;
      ">
        <div style="
          width: 60px;
          height: 60px;
          min-width: 60px;
          min-height: 60px;
          flex-shrink: 0;
          background: rgba(255,255,255,0.14);
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 0.9rem;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          box-shadow: inset 4px 4px 9px rgba(255,255,255,0.05), inset -4px -4px 9px rgba(8,13,24,0.2);
        ">
          ${method.image ? 
            `<img src="${safeImagePath}" data-fallback-icon="fa-money-bill-wave" style="width: 100%; height: 100%; object-fit: cover;">` :
            `<i class="fas fa-money-bill-wave" style="font-size: 1.5rem; color: #C6A75E;"></i>`
          }
        </div>
        <div style="flex: 1;">
          <h4 style="font-weight: 600; margin-bottom: 0.25rem; color: #ffffff;">${safeMethodName}</h4>
          <p style="font-size: 0.85rem; color: rgba(255,255,255,0.75);">${safeInstructions}</p>
        </div>
        <div style="width: 24px; height: 24px; min-width: 24px; min-height: 24px; flex-shrink: 0; border-radius: 999px; border: 2px solid #ffb26e; display: flex; align-items: center; justify-content: center;">
          ${isSelected ? '<div style="width: 12px; height: 12px; border-radius: 999px; background: #ffb26e;"></div>' : ''}
        </div>
      </div>
    `;
  }
  
  renderFormStep(step) {
    const safeTitle = escapeHtml(step?.title || 'Vos informations');
    const safeDescription = escapeHtml(step?.description || '');
    const safeButtonText = escapeHtml(step?.buttonText || 'Continuer');
    return `
      <div>
        <h3 style="font-size: 1.3rem; margin-bottom: 0.5rem;">${safeTitle}</h3>
        <p style="color: #8B7E6B; margin-bottom: 1.5rem;">${safeDescription}</p>
        
        <form id="clientForm" class="space-y-4">
          ${step.fields?.map(field => this.renderFormField(field)).join('') || ''}
        </form>
        
        <button class="next-step-btn" id="nextStepBtn">
          ${safeButtonText}
        </button>
      </div>
    `;
  }
  
  renderFormField(field) {
    const value = this.clientData[field.name] || '';
    const required = field.required ? 'required' : '';
    const safeLabel = escapeHtml(field?.label || '');
    const safeName = escapeAttr(field?.name || '');
    const safeValue = escapeAttr(value);
    
    switch(field.type) {
      case 'textarea':
        return `
          <div class="form-group">
            <label>${safeLabel}${field.required ? ' *' : ''}</label>
            <textarea name="${safeName}" ${required} rows="3">${escapeHtml(value)}</textarea>
          </div>
        `;
      case 'select':
        return `
          <div class="form-group">
            <label>${safeLabel}${field.required ? ' *' : ''}</label>
            <select name="${safeName}" ${required}>
              <option value="">Sélectionnez...</option>
              ${field.options?.map(opt => `
                <option value="${escapeAttr(opt)}" ${value === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>
              `).join('') || ''}
            </select>
          </div>
        `;
      case 'checkbox':
        return `
          <div class="form-group" style="display: flex; align-items: center; gap: 0.5rem;">
            <input type="checkbox" name="${safeName}" id="${safeName}" ${value ? 'checked' : ''}>
            <label for="${safeName}" style="margin: 0;">${safeLabel}${field.required ? ' *' : ''}</label>
          </div>
        `;
      default:
        return `
          <div class="form-group">
            <label>${safeLabel}${field.required ? ' *' : ''}</label>
            <input type="${escapeAttr(field?.type || 'text')}" name="${safeName}" value="${safeValue}" ${required}>
          </div>
        `;
    }
  }
  
  renderPaymentStep(step) {
    if (!this.selectedMethod) {
      return '<p class="text-accent">Veuillez d\'abord sélectionner une méthode</p>';
    }

    const accountName = this.selectedMethod.accountName || 'Jean Pierre';
    const phoneNumber = this.selectedMethod.phoneNumber || '45678909';
    const qrCodePath = this.getImagePath(this.selectedMethod.qrCode || 'qr.png');
    const safeTitle = escapeHtml(step?.title || 'Effectuez le paiement');
    const safeInstruction = escapeHtml(step?.instruction || 'Payez aux coordonnées suivantes :');
    const safeMethodName = escapeHtml(this.selectedMethod?.name || 'Méthode');
    const safeAccountName = escapeHtml(accountName);
    const safePhoneNumber = escapeHtml(phoneNumber);
    const safeMethodImage = escapeAttr(this.getImagePath(this.selectedMethod?.image));
    const safeQrCodePath = escapeAttr(qrCodePath);
    const safeButtonText = escapeHtml(step?.buttonText || "J'ai payé");
    
    return `
      <div>
        <h3 style="font-size: 1.3rem; margin-bottom: 1rem;">${safeTitle}</h3>
        
        <p style="color: #8B7E6B; margin-bottom: 1.5rem;">${safeInstruction}</p>
        
        <div style="
          background: rgba(255,255,255,0.1);
          border-radius: 1rem;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
          border: 1px solid rgba(255,255,255,0.2);
        ">
          <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
            <div style="
              width: 60px;
              height: 60px;
              background: rgba(198,167,94,0.1);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            ">
              ${this.selectedMethod.image ? 
                `<img src="${safeMethodImage}" data-fallback-icon="fa-university" style="width: 100%; height: 100%; object-fit: cover;">` :
                `<i class="fas fa-university" style="font-size: 1.5rem; color: #C6A75E;"></i>`
              }
            </div>
            <div>
              <h4 style="font-weight: 600;">${safeMethodName}</h4>
              <p style="font-size: 0.85rem; color: #8B7E6B;">Compte: ${safeAccountName}</p>
            </div>
          </div>
          
          <div style="
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem 0;
            border-top: 1px solid rgba(198,167,94,0.2);
            border-bottom: 1px solid rgba(198,167,94,0.2);
          ">
            <span style="color: #8B7E6B;">Numéro</span>
            <span style="font-weight: 500;">${safePhoneNumber}</span>
          </div>
          
          <div style="
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem 0;
          ">
            <span style="color: #8B7E6B;">Montant</span>
            <span style="font-weight: bold; font-size: 1.2rem;">${this.formatPrice(this.options.amount || 0)}</span>
          </div>
          
          ${qrCodePath ? `
            <div style="
              display: flex;
              flex-direction: column;
              align-items: center;
              padding: 1rem;
              background: rgba(255,255,255,0.15);
              border-radius: 0.5rem;
            ">
              <p style="font-size: 0.85rem; color: #8B7E6B; margin-bottom: 0.5rem;">Scannez le QR code</p>
              <img src="${safeQrCodePath}" data-hide-on-error="1" style="width: 150px; height: 150px; object-fit: contain;">
            </div>
          ` : ''}
        </div>
        
        <button class="next-step-btn" id="nextStepBtn">
          ${safeButtonText}
        </button>
      </div>
    `;
  }
  
  renderProofStep(step) {
    const expectedName = this.clientData.fullName || this.clientData.name || this.options.client?.name || '';
    const safeTitle = escapeHtml(step?.title || 'Confirmez votre paiement');
    const safeDescription = escapeHtml(step?.description || "Téléchargez une capture d'écran de votre transaction");
    const safeExpectedName = escapeHtml(expectedName);
    const safeExpectedAttr = escapeAttr(expectedName);
    const safeButtonText = escapeHtml(step?.buttonText || 'Soumettre ma demande');
    
    return `
      <div>
        <h3 style="font-size: 1.3rem; margin-bottom: 1rem;">${safeTitle}</h3>
        
        ${expectedName ? `
          <div class="warning-message">
            <i class="fas fa-exclamation-triangle" style="color: #B76E2E; margin-right: 0.5rem;"></i>
            <strong>Important :</strong> Le nom que vous saisissez doit correspondre exactement à celui de l'étape précédente : 
            <strong style="color: #1F1E1C;">${safeExpectedName}</strong>
          </div>
        ` : ''}
        
        <p style="color: #8B7E6B; margin-bottom: 1.5rem;">${safeDescription}</p>
        
        <form id="proofForm" class="space-y-4">
          <div class="form-group">
            <label>Confirmez votre nom *</label>
            <input type="text" id="proofName" required placeholder="Votre nom exact" value="${safeExpectedAttr}">
          </div>
          
          <div class="form-group">
            <label>Capture d'écran de la transaction *</label>
            <input type="file" id="proofImage" accept="image/*" required>
            <p style="font-size: 0.8rem; color: #8B7E6B; margin-top: 0.25rem;">Format accepté : JPG, PNG (max 5 Mo)</p>
          </div>
          
          <div id="imagePreview" style="display: none; margin-top: 1rem; text-align: center;">
            <img id="previewImg" style="max-width: 100%; max-height: 200px; border-radius: 0.5rem; border: 1px solid rgba(198,167,94,0.3);">
          </div>
        </form>
        
        <button class="next-step-btn" id="nextStepBtn">
          ${safeButtonText}
        </button>
      </div>
    `;
  }
  
  renderConfirmationStep(step) {
    this.startCountdown();
    const safeMessage = escapeHtml(step?.message || 'Votre demande est en cours de vérification. Elle sera traitée sous 12 heures.');
    
    return `
      <div style="text-align: center; padding: 1rem 0;">
        <div style="
          width: 100px;
          height: 100px;
          background: #2E5D3A;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 1.5rem;
        ">
          <i class="fas fa-check" style="font-size: 3rem; color: white;"></i>
        </div>
        
        <h3 style="font-size: 1.5rem; margin-bottom: 1rem;">Demande soumise avec succès !</h3>
        
        <p style="color: #8B7E6B; margin-bottom: 2rem;">
          ${safeMessage}
        </p>
        
        <div style="
          background: white;
          border-radius: 1rem;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        ">
          <p style="font-size: 0.9rem; color: #8B7E6B; margin-bottom: 0.5rem;">Temps restant avant vérification</p>
          <div class="countdown-timer" id="countdownTimer">12:00:00</div>
        </div>
        
        <p style="font-size: 0.9rem; color: #8B7E6B;">
          <i class="fas fa-clock" style="margin-right: 0.3rem;"></i>
          Vous pouvez suivre le statut de votre demande dans le module solde.
        </p>
        
        <button class="next-step-btn" id="closeAfterConfirmation" style="margin-top: 2rem;">
          Fermer
        </button>
      </div>
    `;
  }
  
  renderCustomStep(step) {
    const safeTitle = escapeHtml(step?.title || 'Étape personnalisée');
    const safeContent = escapeHtml(step?.content || '');
    const safeButtonText = escapeHtml(step?.buttonText || 'Continuer');
    return `
      <div>
        <h3 style="font-size: 1.3rem; margin-bottom: 1rem;">${safeTitle}</h3>
        <div style="
          background: white;
          border-radius: 1rem;
          padding: 1.5rem;
          white-space: pre-line;
        ">
          ${safeContent}
        </div>
        
        <button class="next-step-btn" id="nextStepBtn">
          ${safeButtonText}
        </button>
      </div>
    `;
  }
  
  renderNoSteps() {
    return `
      <div style="text-align: center; padding: 2rem;">
        <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: #B76E2E; margin-bottom: 1rem;"></i>
        <h3 style="font-size: 1.2rem; margin-bottom: 1rem;">Configuration incomplète</h3>
        <p style="color: #8B7E6B;">Cette méthode de paiement n'est pas correctement configurée.</p>
      </div>
    `;
  }
  
  attachEvents() {
    this.bindAssetFallbacks();

    const closeBtn = this.modal.querySelector('.close-payment');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    const backBtn = this.modal.querySelector('.back-step');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.goBack());
    }
    
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });
    
    if (this.currentStep === 0) {
      this.attachStep0Events();
    } else {
      this.attachStepEvents();
    }
    
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    });
  }

  bindAssetFallbacks() {
    if (!this.modal) return;

    this.modal.querySelectorAll('img[data-hide-on-error="1"]').forEach((img) => {
      if (img.dataset.errorBound === '1') return;
      img.dataset.errorBound = '1';
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
    });

    this.modal.querySelectorAll('img[data-fallback-icon]').forEach((img) => {
      if (img.dataset.errorBound === '1') return;
      img.dataset.errorBound = '1';
      img.addEventListener('error', () => {
        const parent = img.parentElement;
        if (!parent) {
          img.style.display = 'none';
          return;
        }
        if (parent.dataset.fallbackApplied === '1') return;
        parent.dataset.fallbackApplied = '1';
        while (parent.firstChild) {
          parent.removeChild(parent.firstChild);
        }
        const icon = document.createElement('i');
        icon.className = `fas ${img.dataset.fallbackIcon || 'fa-image'}`;
        icon.style.fontSize = '1.5rem';
        icon.style.color = '#C6A75E';
        parent.appendChild(icon);
      });
    });
  }
  
  attachStep0Events() {
    const methodsList = this.modal.querySelector('#methodsList');
    
    if (methodsList) {
      methodsList.querySelectorAll('.method-card').forEach(card => {
        card.addEventListener('click', () => {
          const methodId = card.dataset.methodId;
          const method = this.methods.find(m => m.id === methodId);
          
          if (method) {
            this.selectedMethod = method;
            this.steps = this.getMethodSteps(this.selectedMethod);
            this.currentStep = 1;
            this.updateStepDisplay();
          }
        });
      });
    }
  }
  
  attachStepEvents() {
    const nextBtn = this.modal.querySelector('#nextStepBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => this.handleNextStep());
    }
    
    const closeBtn = this.modal.querySelector('#closeAfterConfirmation');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    const proofImage = this.modal.querySelector('#proofImage');
    if (proofImage) {
      proofImage.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 5 * 1024 * 1024) {
            alert('L\'image est trop volumineuse. Taille maximum : 5 Mo');
            proofImage.value = '';
            return;
          }
          
          const reader = new FileReader();
          reader.onload = (e) => {
            const preview = this.modal.querySelector('#imagePreview');
            const img = this.modal.querySelector('#previewImg');
            if (preview && img) {
              img.src = e.target.result;
              preview.style.display = 'block';
            }
            this.proofImageFile = file;
          };
          reader.readAsDataURL(file);
        }
      });
    }
  }
  
  goBack() {
    if (this.currentStep > 0 && this.currentStep < this.steps.length) {
      this.currentStep--;
      this.updateStepDisplay();
    }
  }
  
  async handleNextStep() {
    const stepIndex = this.currentStep - 1;
    const step = this.steps[stepIndex];
    
    if (!step) return;
    
    const nextBtn = this.modal.querySelector('#nextStepBtn');
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.innerHTML = '<div class="loading-spinner"></div> Traitement...';
    }
    
    try {
      let isValid = true;
      
      switch(step.type) {
        case 'form':
          isValid = this.validateFormStep();
          break;
        case 'proof':
          isValid = await this.validateProofStep();
          break;
        case 'payment':
          break;
        default:
          break;
      }
      
      if (!isValid) {
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.innerHTML = step.buttonText || 'Continuer';
        }
        return;
      }
      
      if (step.type === 'proof') {
        this.isSubmitted = true;
        this.isCompleted = true;
        
        this.currentStep++;
        this.updateStepDisplay();
        
        return;
      }
      
      if (this.currentStep < this.steps.length) {
        this.currentStep++;
        this.updateStepDisplay();
      }
    } catch (error) {
      console.error('❌ Erreur:', error);
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.innerHTML = step.buttonText || 'Continuer';
      }
      alert('Une erreur est survenue. Veuillez réessayer.');
    }
  }
  
  validateFormStep() {
    const form = this.modal.querySelector('#clientForm');
    if (!form) return false;
    
    const inputs = form.querySelectorAll('input, textarea, select');
    let isValid = true;
    let firstInvalid = null;
    
    inputs.forEach(input => {
      if (input.hasAttribute('required') && !input.value.trim()) {
        input.style.borderColor = '#7F1D1D';
        isValid = false;
        if (!firstInvalid) firstInvalid = input;
      } else {
        input.style.borderColor = 'rgba(198,167,94,0.3)';
      }
    });
    
    if (!isValid && firstInvalid) {
      firstInvalid.focus();
      alert('Veuillez remplir tous les champs obligatoires');
      return false;
    }
    
    if (isValid) {
      inputs.forEach(input => {
        if (input.type === 'checkbox') {
          this.clientData[input.name] = input.checked;
        } else {
          this.clientData[input.name] = input.value.trim();
        }
      });
    }
    
    return isValid;
  }

  async extractTextFromProofImage(imageFile) {
    if (!imageFile) return '';
    const tesseract = await loadTesseractRuntime();
    const result = await tesseract.recognize(imageFile, OCR_LANGUAGE, { logger: () => {} });
    const raw = String(result?.data?.text || '');
    return raw.replace(/[ \t]+\n/g, '\n').trim();
  }
  
  async validateProofStep() {
    const proofName = this.modal.querySelector('#proofName')?.value.trim();
    const proofImage = this.modal.querySelector('#proofImage')?.files[0];
    
    if (!proofName) {
      alert('Veuillez confirmer votre nom');
      return false;
    }
    
    const expectedName = this.clientData.fullName || this.clientData.name || this.options.client?.name || '';
    if (expectedName && proofName !== expectedName) {
      alert(`Le nom "${proofName}" ne correspond pas à "${expectedName}". Veuillez saisir le même nom.`);
      return false;
    }
    
    if (!proofImage && !this.proofImageFile) {
      alert('Veuillez sélectionner une image');
      return false;
    }
    
    const imageFile = this.proofImageFile || proofImage;
    this.extractedText = '';
    this.extractedTextStatus = 'pending';

    try {
      this.extractedText = await this.extractTextFromProofImage(imageFile);
      this.extractedTextStatus = this.extractedText ? 'success' : 'empty';
    } catch (ocrError) {
      console.error('❌ Erreur OCR:', ocrError);
      this.extractedText = '';
      this.extractedTextStatus = 'failed';
    }
    
    await this.saveOrder(proofName);
    
    return true;
  }
  
  async saveOrder(proofName) {
    try {
      if (!this.options.client || !this.options.client.id) {
        console.error('❌ Client non disponible');
        return false;
      }

      const normalizedItems = Array.isArray(this.options.cart)
        ? this.options.cart.map((item) => {
            const quantity = Number(item?.quantity) || 1;
            const price = Number(item?.price) || 0;
            return {
              productId: item?.productId || '',
              name: item?.name || 'Produit',
              price,
              quantity,
              sku: item?.sku || '',
              image: item?.image || '',
              selectedOptions: Array.isArray(item?.selectedOptions) ? item.selectedOptions : []
            };
          })
        : [];
      const computedAmount = normalizedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const finalAmount = Number(this.options.amount) || computedAmount;
      
      const uniqueCode = 'VLX-' + Math.random().toString(36).substr(2, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
      
      const orderData = {
        amount: finalAmount,
        clientId: this.options.client?.id || '',
        clientUid: this.options.client?.uid || '',
        methodId: this.selectedMethod?.id,
        methodName: this.selectedMethod?.name,
        methodDetails: {
          name: this.selectedMethod?.name,
          accountName: this.selectedMethod?.accountName,
          phoneNumber: this.selectedMethod?.phoneNumber
        },
        delivery: this.options.delivery || null,
        shippingAmount: Number(this.options.delivery?.totalFee || 0),
        weightFee: Number(this.options.delivery?.weightFee || 0),
        items: normalizedItems,
        status: 'pending',
        uniqueCode: uniqueCode,
        extractedText: this.extractedText,
        extractedTextStatus: this.extractedTextStatus,
        extractedTextAt: new Date().toISOString(),
        proofName: proofName,
        clientData: this.clientData,
        customerName: this.clientData.fullName || this.clientData.name || this.options.client?.name || '',
        customerEmail: this.clientData.email || this.options.client?.email || '',
        customerPhone: this.clientData.phone || this.options.client?.phone || '',
        customerAddress: this.clientData.address || this.options.client?.address || '',
        customerCity: this.clientData.city || this.options.client?.city || '',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ((this.settings.verificationHours || 12) * 60 * 60 * 1000)).toISOString()
      };

      const response = await createOrderSecure({
        methodId: this.selectedMethod?.id || '',
        amountHtg: finalAmount,
        customerName: orderData.customerName,
        customerEmail: orderData.customerEmail,
        customerPhone: orderData.customerPhone,
        proofRef: proofName,
        extractedText: this.extractedText,
        extractedTextStatus: this.extractedTextStatus,
      });
      const orderId = response?.orderId || '';
      
      document.dispatchEvent(new CustomEvent('orderSaved', {
        detail: { id: orderId, clientId: this.options.client.id, order: orderData }
      }));
      
      if (this.options.onSuccess) {
        this.options.onSuccess({ id: orderId, ...orderData });
      }
      
      return true;
    } catch (error) {
      console.error('❌ Erreur sauvegarde commande:', error);
      throw error;
    }
  }
  
  updateStepDisplay() {
    const header = this.modal.querySelector('.payment-container-' + this.uniqueId + ' > div:first-child');
    if (header) {
      const titleDiv = header.querySelector('div:first-child');
      if (titleDiv) {
        titleDiv.innerHTML = `
          <div style="display: flex; align-items: center; gap: 1rem;">
            ${this.currentStep > 0 && this.currentStep < (this.steps?.length || 0) && !this.isSubmitted ? `
              <button class="back-step payment-icon-btn" style="
                background: none;
                border: none;
                font-size: 1.2rem;
                cursor: pointer;
                color: #8B7E6B;
                padding: 0.5rem;
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: all 0.2s;
              ">
                <i class="fas fa-arrow-left"></i>
              </button>
            ` : ''}
            <h2 style="
              font-family: 'Cormorant Garamond', serif;
              font-size: 1.5rem;
              color: #1F1E1C;
              margin: 0;
            ">
              Paiement sécurisé
            </h2>
          </div>
          <button class="close-payment payment-icon-btn" style="
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: #8B7E6B;
            transition: all 0.2s;
            padding: 0.5rem;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
          ">
            <i class="fas fa-times"></i>
          </button>
        `;
      }
      
      const oldProgress = header.querySelector('div[style*="margin-top: 0.5rem"]');
      if (oldProgress) {
        oldProgress.remove();
      }
      
      if (this.currentStep < (this.steps?.length || 0) && !this.isSubmitted) {
        const newProgress = document.createElement('div');
        newProgress.innerHTML = this.renderProgressBar();
        header.appendChild(newProgress.firstChild);
      }
    }
    
    const content = this.modal.querySelector('.payment-container-' + this.uniqueId + ' > div:nth-child(2)');
    if (content) {
      content.innerHTML = this.renderCurrentStep();
    }
    
    this.attachEvents();
  }
  
  startCountdown() {
    const hours = this.settings.verificationHours || 12;
    this.timeLeft = hours * 60 * 60;
    
    const updateTimer = () => {
      if (this.timeLeft <= 0) {
        clearInterval(this.countdownInterval);
        const timer = this.modal.querySelector('#countdownTimer');
        if (timer) {
          timer.textContent = 'Expiré';
          timer.style.color = '#7F1D1D';
        }
        return;
      }
      
      const h = Math.floor(this.timeLeft / 3600);
      const m = Math.floor((this.timeLeft % 3600) / 60);
      const s = this.timeLeft % 60;
      
      const timer = this.modal.querySelector('#countdownTimer');
      if (timer) {
        timer.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      }
      
      this.timeLeft--;
    };
    
    updateTimer();
    this.countdownInterval = setInterval(updateTimer, 1000);
  }
  
  animateIn() {
    setTimeout(() => {
      this.modal.style.opacity = '1';
    }, 50);
  }
  
  animateOut() {
    return new Promise(resolve => {
      this.modal.style.opacity = '0';
      const container = this.modal.querySelector('.payment-container-' + this.uniqueId);
      if (container) {
        container.style.transform = 'scale(0.95)';
      }
      setTimeout(resolve, 300);
    });
  }
  
  async close() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    
    await this.animateOut();
    this.modal.remove();
    document.body.style.overflow = '';
    
    if (this.options.onClose) {
      this.options.onClose();
    }
  }
}

export default PaymentModal;

import { Router } from 'express';
import { createProfessionalController } from '../controllers/professionalController.js';
export default function professionalRoutes(context) {
  const router = Router(),
    c = createProfessionalController(context);
  router.put('/profile', c.updateProfile);
  router.get('/services', c.services);
  router.post('/services', c.addService);
  router.put('/services/:id', c.editService);
  router.delete('/services/:id', c.deleteService);
  router.put('/schedule', c.saveSchedule);
  router.get('/blocks', c.blocks);
  router.post('/blocks', c.addBlock);
  router.delete('/blocks/:id', c.removeBlock);
  router.get('/appointments', c.appointments);
  router.post('/appointments', c.addAppointment);
  router.patch('/appointments/:id/status', c.changeStatus);
  router.get('/clients', c.clients);
  router.get('/clients/:id/history', c.clientHistory);
  router.get('/reports', c.reports);
  router.get('/notifications', c.notifications);
  return router;
}
